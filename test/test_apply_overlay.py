import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("apply_overlay", Path(__file__).resolve().parents[1] / "scripts/apply-overlay.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OverlaySafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / "project"
        self.source = Path(self.temp.name) / "source"
        (self.project / "config").mkdir(parents=True)
        (self.project / "artifacts/overlay").mkdir(parents=True)
        self.source.mkdir()
        self.upstream = {"revision": "a" * 40}
        (self.project / "config/upstream.json").write_text(json.dumps(self.upstream))

    def manifest(self, entries):
        (self.project / "artifacts/overlay-manifest.json").write_text(json.dumps({"upstream": self.upstream, "files": entries}))

    def entry(self, name, old=b"original", new=b"updated"):
        (self.source / name).write_bytes(old)
        (self.project / "artifacts/overlay" / name).write_bytes(new)
        return {"path": name, "sha256": module.digest(new), "originalSha256": module.digest(old)}

    def test_bad_second_input_does_not_modify_first_source(self):
        first, second = self.entry("first"), self.entry("second")
        second["sha256"] = "0" * 64
        self.manifest([first, second])
        with patch.object(module.subprocess, "check_output", return_value=self.upstream["revision"]):
            with self.assertRaisesRegex(ValueError, "Overlay hash mismatch"):
                module.apply(self.project, self.source)
        self.assertEqual((self.source / "first").read_bytes(), b"original")

    def test_modified_checkout_is_not_overwritten(self):
        entry = self.entry("first")
        (self.source / "first").write_bytes(b"user edit")
        self.manifest([entry])
        with patch.object(module.subprocess, "check_output", return_value=self.upstream["revision"]):
            with self.assertRaisesRegex(ValueError, "Unexpected source modification"):
                module.apply(self.project, self.source)
        self.assertEqual((self.source / "first").read_bytes(), b"user edit")

    def test_wrong_revision_is_rejected(self):
        self.manifest([self.entry("first")])
        with patch.object(module.subprocess, "check_output", return_value="b" * 40):
            with self.assertRaisesRegex(ValueError, "Checkout revision mismatch"):
                module.apply(self.project, self.source)

    def test_only_the_pinned_previous_overlay_can_be_migrated(self):
        entry = self.entry("name.xml", old=b"upstream", new=b"new branding")
        entry["previousSha256"] = module.digest(b"previous branding")
        self.manifest([entry])
        (self.source / "name.xml").write_bytes(b"previous branding plus user edit")
        with patch.object(module.subprocess, "check_output", return_value=self.upstream["revision"]):
            with self.assertRaisesRegex(ValueError, "Unexpected source modification"):
                module.apply(self.project, self.source)
            (self.source / "name.xml").write_bytes(b"previous branding")
            module.apply(self.project, self.source)
            self.assertEqual((self.source / "name.xml").read_bytes(), b"new branding")
            module.apply(self.project, self.source)

    def test_traversal_and_symlinks_cannot_escape(self):
        with self.assertRaisesRegex(ValueError, "escapes root"):
            module.confined(self.source, "../outside")
        (self.source / "link").symlink_to(self.project, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes root"):
            module.confined(self.source, "link/config/upstream.json")

    def test_only_an_exact_previous_overlay_can_be_removed(self):
        target = self.source / "old-icon.xml"
        target.write_bytes(b"old icon")
        entry = {"path": "old-icon.xml", "delete": True, "originalSha256": None,
                 "previousSha256": module.digest(b"old icon")}
        self.manifest([entry])
        with patch.object(module.subprocess, "check_output", return_value=self.upstream["revision"]):
            module.apply(self.project, self.source)
        self.assertFalse(target.exists())

        target.write_bytes(b"user icon")
        with patch.object(module.subprocess, "check_output", return_value=self.upstream["revision"]):
            with self.assertRaisesRegex(ValueError, "Unexpected source modification"):
                module.apply(self.project, self.source)
        self.assertEqual(target.read_bytes(), b"user icon")


if __name__ == "__main__":
    unittest.main()
