import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteStrings } from '../scripts/branding.mjs';

const path = 'mobile/android/fenix/app/src/main/res/values/strings.xml';
const branding = { displayName: 'Белый лис', about: { default: '%1$s is independent, based on Mozilla Firefox.', ru: '%1$s — независимый браузер на основе Mozilla Firefox.' } };
const rewrite = (xml, file = path, russian = {}) => rewriteStrings(xml, file, branding, russian, [], []);

test('changes app labels but preserves licence comments, service names, consent recipients and URLs', () => {
  const xml = '<resources><!-- Firefox, Mozilla Public License -->' +
    '<string name="onboarding_welcome_to_firefox">Welcome to Firefox</string>' +
    '<string name="firefox_suggest_header">Firefox Suggest</string>' +
    '<string name="sign_in_instructions"><![CDATA[Open Firefox at https://firefox.com/pair]]></string>' +
    '<string name="onboarding_term_of_service_line_three">Firefox sends data to Mozilla. %1$s</string></resources>';
  const result = rewrite(xml);
  assert.match(result, /Welcome to Белый лис/);
  assert.match(result, /<!-- Firefox, Mozilla Public License -->/);
  assert.match(result, /Firefox Suggest/);
  assert.match(result, /Open Firefox at https:\/\/firefox.com\/pair/);
  assert.match(result, /Белый лис sends data to Mozilla\. %1\$s/);
});

test('handles inflected brand names without leaving a Latin suffix', () => {
  assert.equal(rewrite('<string name="micro_survey_prompt_title">Firefoxista</string>'), '<string name="micro_survey_prompt_title">Белый лис</string>');
});

test('does not rename an external component provider even when its key is familiar', () => {
  const xml = '<string name="firefox">Firefox</string>';
  assert.equal(rewrite(xml, 'mobile/android/android-components/components/service/res/values/strings.xml'), xml);
});

test('rejects lost or changed placeholders and changed URLs', () => {
  const ruPath = path.replace('/values/', '/values-ru/');
  assert.throws(() => rewrite('<string name="title">%1$s %2$d</string>', ruPath, { title: '%1$s' }), /Format arguments changed/);
  assert.throws(() => rewrite('<string name="title">https://mozilla.org/</string>', ruPath, { title: 'https://example.org/' }), /URL changed/);
});

test('about copy describes the fork without dropping the product placeholder', () => {
  assert.equal(rewrite('<string name="about_content">%1$s is produced by Mozilla.</string>'), '<string name="about_content">%1$s is independent, based on Mozilla Firefox.</string>');
});
