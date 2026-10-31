package ru.belylis;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.HttpURLConnection;
import java.net.URL;

public class WhiteFoxUpdater {
    private static final String BELYLIS_VERSION = "@BELYLIS_VERSION@";
    public static final int CA_MODE_DISABLED = 0;
    public static final int CA_MODE_RU_ONLY = 1;
    public static final int CA_MODE_ALL = 2;

    private static final String PREF_KEY_CA_MODE = "pref_key_belylis_ca_mode";
    private static final String GITHUB_API_URL = "https://api.github.com/repos/ezhkov-ph/bely-lis-android/releases/latest";

    public static int getCaMode(Context context) {
        if (context == null) return CA_MODE_RU_ONLY;
        try {
            File file = new File(context.getFilesDir(), "belylis_ca_mode.txt");
            if (file.exists()) {
                BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(file), "UTF-8"));
                String line = br.readLine();
                br.close();
                if (line != null) {
                    int val = Integer.parseInt(line.trim());
                    if (val == CA_MODE_DISABLED || val == CA_MODE_RU_ONLY || val == CA_MODE_ALL) {
                        return val;
                    }
                }
            }
        } catch (Throwable ignored) {}
        try {
            SharedPreferences sp = context.getSharedPreferences("belylis_settings", Context.MODE_PRIVATE);
            return sp.getInt("ca_mode", CA_MODE_RU_ONLY);
        } catch (Throwable ignored) {}
        return CA_MODE_RU_ONLY;
    }

    public static void setCaMode(Context context, int mode) {
        if (context == null) return;
        try {
            SharedPreferences sp = context.getSharedPreferences("belylis_settings", Context.MODE_PRIVATE);
            sp.edit().putInt("ca_mode", mode).apply();
        } catch (Throwable ignored) {}
        try {
            File file = new File(context.getFilesDir(), "belylis_ca_mode.txt");
            FileOutputStream fos = new FileOutputStream(file);
            fos.write(String.valueOf(mode).getBytes("UTF-8"));
            fos.flush();
            fos.close();
        } catch (Throwable ignored) {}
    }

    public static String getCaModeSummary(int mode) {
        switch (mode) {
            case CA_MODE_ALL:
                return "Применено для всех сайтов\n(Не рекомендуется)";
            case CA_MODE_DISABLED:
                return "Отключено";
            case CA_MODE_RU_ONLY:
            default:
                return "Применено для российских сайтов\n(Включено по умолчанию)";
        }
    }

    public static void updateCaSummary(Object pref, Context context) {
        if (pref == null || context == null) return;
        try {
            int mode = getCaMode(context);
            Method setSummaryMethod = pref.getClass().getMethod("setSummary", CharSequence.class);
            setSummaryMethod.invoke(pref, getCaModeSummary(mode));
        } catch (Throwable ignored) {}
    }

    public static void showCaModeDialog(final Activity activity, final Object pref) {
        if (activity == null || activity.isFinishing()) return;

        AlertDialog.Builder builder = new AlertDialog.Builder(activity);
        builder.setTitle("Сертификаты Минцифры — эксперимент");

        final String[] options = new String[] {
            "Применено для российских сайтов\n(Включено по умолчанию)",
            "Применено для всех сайтов\n(Не рекомендуется)",
            "Отключено"
        };
        final int[] modes = new int[] { CA_MODE_RU_ONLY, CA_MODE_ALL, CA_MODE_DISABLED };

        int currentMode = getCaMode(activity);
        int checkedIndex = 0;
        if (currentMode == CA_MODE_ALL) checkedIndex = 1;
        else if (currentMode == CA_MODE_DISABLED) checkedIndex = 2;

        builder.setSingleChoiceItems(options, checkedIndex, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                int selectedMode = modes[which];
                setCaMode(activity, selectedMode);
                updateCaSummary(pref, activity);
                dialog.dismiss();
                Toast.makeText(activity, "Настройка сохранена", Toast.LENGTH_SHORT).show();
            }
        });

        builder.setNegativeButton("Отмена", null);
        builder.show();
    }

    public static void checkUpdate(final Context context) {
        if (context instanceof Activity) {
            checkUpdate((Activity) context);
        }
    }

    public static void checkUpdate(final Activity activity) {
        if (activity == null || activity.isFinishing()) return;

        Toast.makeText(activity, "Проверка обновлений...", Toast.LENGTH_SHORT).show();

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    URL url = new URL(GITHUB_API_URL);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("User-Agent", "BelyLis-Browser");
                    conn.setRequestProperty("Accept", "application/vnd.github.v3+json");
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(10000);

                    int responseCode = conn.getResponseCode();
                    if (responseCode != 200) {
                        showToast(activity, "Ошибка проверки: сервер вернул код " + responseCode);
                        return;
                    }

                    BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                    reader.close();

                    JSONObject json = new JSONObject(sb.toString());
                    final String tagName = json.optString("tag_name", "");

                    String apkUrl = "";
                    JSONArray assets = json.optJSONArray("assets");
                    if (assets != null) {
                        for (int i = 0; i < assets.length(); i++) {
                            JSONObject asset = assets.getJSONObject(i);
                            String name = asset.optString("name", "");
                            if (name.endsWith(".apk")) {
                                apkUrl = asset.optString("browser_download_url", "");
                                if (name.contains("arm64")) {
                                    break;
                                }
                            }
                        }
                    }

                    final String finalApkUrl = apkUrl;
                    String currentVersion = BELYLIS_VERSION;

                    final boolean hasUpdate = isNewerVersion(currentVersion, tagName);
                    final String currentVerStr = currentVersion;

                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (activity.isFinishing()) return;
                            if (hasUpdate && !finalApkUrl.isEmpty()) {
                                showUpdateDialog(activity, tagName, finalApkUrl);
                            } else {
                                Toast.makeText(activity, "У вас установлена актуальная версия (" + currentVerStr + ")", Toast.LENGTH_LONG).show();
                            }
                        }
                    });

                } catch (final Exception e) {
                    showToast(activity, "Не удалось проверить обновления: " + e.getMessage());
                }
            }
        }).start();
    }

    private static class Version {
        int major = 0;
        int minor = 0;
        int patch = 0;
        int build = 0;
        boolean hasBuild = false;

        static Version parse(String str) {
            Version v = new Version();
            if (str == null || str.trim().isEmpty()) return v;
            String s = str.trim();
            if (s.startsWith("v") || s.startsWith("V")) {
                s = s.substring(1);
            }
            int dashIdx = s.indexOf('-');
            if (dashIdx != -1) {
                String suffix = s.substring(dashIdx + 1);
                s = s.substring(0, dashIdx);
                if (suffix.contains("belylis")) {
                    String num = suffix.replaceAll("[^0-9]", "");
                    if (!num.isEmpty()) {
                        try {
                            v.build = Integer.parseInt(num);
                            v.hasBuild = true;
                        } catch (Exception ignored) {}
                    }
                }
            }
            String[] parts = s.split("\\.");
            try {
                if (parts.length > 0) v.major = Integer.parseInt(parts[0].replaceAll("[^0-9]", ""));
                if (parts.length > 1) v.minor = Integer.parseInt(parts[1].replaceAll("[^0-9]", ""));
                if (parts.length > 2) v.patch = Integer.parseInt(parts[2].replaceAll("[^0-9]", ""));
            } catch (Exception ignored) {}
            return v;
        }
    }

    public static boolean isNewerVersion(String current, String remote) {
        if (remote == null || remote.trim().isEmpty()) return false;
        if (current == null || current.trim().isEmpty()) return false;

        Version c = Version.parse(current);
        Version r = Version.parse(remote);

        if (r.major > c.major) return true;
        if (r.major < c.major) return false;

        if (r.minor > c.minor) return true;
        if (r.minor < c.minor) return false;

        if (r.patch > c.patch) return true;
        if (r.patch < c.patch) return false;

        if (c.hasBuild && r.hasBuild) {
            return r.build > c.build;
        }

        return false;
    }

    private static void showToast(final Activity activity, final String msg) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!activity.isFinishing()) {
                    Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private static void showUpdateDialog(final Activity activity, final String tagName, final String downloadUrl) {
        AlertDialog.Builder builder = new AlertDialog.Builder(activity);
        builder.setTitle("Доступно обновление");
        String message = "Найдена новая версия: " + tagName + "\n\nХотите скачать и установить обновление?";
        builder.setMessage(message);
        builder.setPositiveButton("Скачать", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                try {
                    Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl));
                    activity.startActivity(browserIntent);
                } catch (Exception e) {
                    Toast.makeText(activity, "Не удалось открыть ссылку: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            }
        });
        builder.setNegativeButton("Позже", null);
        builder.show();
    }
}
