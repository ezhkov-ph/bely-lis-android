const appPrefix = 'mobile/android/fenix/app/src/';
const brandPattern = /\b(?:Firefox(?: Fenix| Nightly| Beta)?|Fenix|Fennec)[a-z]*\b/g;
const tokenPattern = /<!--[^]*?-->|<string\b([^>]*\bname="([^"]+)"[^>]*)>([^]*?)<\/string>/g;
const formatTokens = text => (text.match(/%(?:\d+\$)?[-#+ 0,(<]*\d*(?:\.\d+)?[a-zA-Z%]/g) ?? []).sort();

export const applicationKeys = new Set(`
app_name firefox app_name_firefox preferences_category_about
onboarding_preferences_dialog_title onboarding_preferences_dialog_usage_data_description_2
onboarding_welcome_to_firefox onboarding_term_of_service_line_three onboarding_redesign_tou_body_three
nova_onboarding_tou_body_line_3 nova_onboarding_notifications_title nova_onboarding_notifications_subtitle
nova_onboarding_add_search_widget_subtitle nova_onboarding_add_search_widget_button
addon_ga_message_body preferences_usage_data_description_1 studies_description_4 remote_improvements_description
nimbus_notification_default_browser_title nimbus_notification_default_browser_text nimbus_survey_message_text
ip_protection_location_fastest_description inactive_tabs_auto_close_message_description
default_browser_experiment_card_text micro_survey_prompt_title likert_scale_option_7 likert_scale_option_i_plan_to_keep_using
microsurvey_prompt_printing_title microsurvey_prompt_search_title microsurvey_prompt_sync_title
microsurvey_survey_printing_title microsurvey_homepage_title microsurvey_search_title microsurvey_sync_title
microsurvey_describe_your_experience_title microsurvey_app_icon_content_description
certificate_warning_homepage_card_hca1_title certificate_warning_homepage_card_hcr1_message
certificate_warning_homepage_card_hcw2_message certificate_warning_homepage_card_hcw3_title
certificate_warning_homepage_card_hcw3_message certificate_warning_push_notification_pnw2_title
firefox_labs_title preferences_debug_settings_firefox_labs
preferences_sync_debug_quit_button_title preferences_sync_debug_quit_button_summary
profiler_filter_firefox profiler_filter_firefox_explain profiler_filter_graphics_explain
profiler_filter_media_explain profiler_filter_networking_explain
`.trim().split(/\s+/));

const externalKeys = new Set(`
onboarding_term_of_service_line_one_link_text_2 onboarding_redesign_tou_body_one_link_text
nova_onboarding_tou_body_line_1_link_text nova_onboarding_tou_body_line_1
onboarding_term_of_service_line_two_2 onboarding_redesign_tou_body_two nova_onboarding_tou_body_line_2
onboarding_redesign_sync_title fxa_received_tab_channel_description sync_connect_device_dialog
sign_in_instructions sign_in_create_account_text synced_tabs_no_tabs pair_instructions_2
preference_search_address_bar_fx_suggest preference_search_learn_about_fx_suggest firefox_suggest_header firefox_suggest_online_header
preferences_debug_settings_fxsuggest search_add_custom_engine_suggest_string_example_2
privacy_notice_updated_homepage_message
`.trim().split(/\s+/));

export function preservationReason(key, path) {
  if (!path.startsWith(appPrefix)) return 'External Mozilla component/service; preserve its identity and notices';
  if (/marketing/.test(key)) return 'Mozilla marketing consent/campaign; not relabelled as our campaign';
  if (externalKeys.has(key)) return 'External Firefox service, legal document, desktop/Sync instruction or technical URL';
  return 'Mozilla attribution/service/provider or unreviewed string; not automatically rewritten';
}

export function rewriteStrings(xml, path, branding, russian, changes, preserved) {
  const isApp = path.startsWith(appPrefix);
  const isRussian = path.includes('/values-ru/');
  return xml.replace(tokenPattern, (whole, attributes, key, value) => {
    if (whole.startsWith('<!--')) return whole;
    let result = value;
    if (isApp && key === 'about_content') {
      result = branding.about[isRussian ? 'ru' : 'default'];
    } else if (isApp && isRussian && Object.hasOwn(russian, key)) {
      result = russian[key];
    } else if (isApp && applicationKeys.has(key)) {
      result = value.replace(brandPattern, branding.displayName);
    }
    if (result !== value) {
      if (JSON.stringify(formatTokens(value)) !== JSON.stringify(formatTokens(result))) {
        throw new Error(`Format arguments changed: ${path}:${key}`);
      }
      const urls = value.match(/https?:[^\s<>]+/g) ?? [];
      if (urls.some(url => !result.includes(url))) throw new Error(`URL changed: ${path}:${key}`);
      changes.push({ path, key, before: value, after: result });
    }
    if (/Firefox|Fenix|Fennec|Mozilla/.test(result)) {
      preserved.push({ path, key, value: result, reason: key === 'about_content' ? 'Explicit upstream attribution and independence notice' : preservationReason(key, path) });
    }
    return `<string${attributes}>${result}</string>`;
  });
}

function replaceOnce(text, before, after, path) {
  if (text.split(before).length !== 2) throw new Error(`Unexpected branding source layout: ${path}`);
  return text.replace(before, after);
}

export async function prepareBranding({ source, pins, branding, russian, outputs }) {
  const changes = [];
  const preserved = [];
  for (const path of Object.keys(pins.files)) {
    if (!path.endsWith('.xml') || !path.includes('/values')) continue;
    const original = await source(path);
    const updated = rewriteStrings(original, path, branding, russian, changes, preserved);
    if (updated !== original) outputs.set(path, updated);
  }

  const brandRoot = 'mobile/android/branding/unofficial/';
  for (const [file, replacements] of [
    ['configure.sh', [['MOZ_APP_DISPLAYNAME="Fennec"', `MOZ_APP_DISPLAYNAME="${branding.displayName}"`]]],
    ['locales/en-US/brand.properties', [['brandShortName=Fennec', `brandShortName=${branding.displayName}`], ['brandFullName=Mozilla Fennec', `brandFullName=${branding.displayName}`]]],
    ['locales/en-US/brand.ftl', [['-brand-short-name = Fennec', `-brand-short-name = ${branding.displayName}`], ['-brand-full-name = Mozilla Fennec', `-brand-full-name = ${branding.displayName}`], ['-brand-product-name = Firefox', `-brand-product-name = ${branding.displayName}`]]],
  ]) {
    const path = brandRoot + file;
    let text = await source(path);
    for (const [before, after] of replacements) text = replaceOnce(text, before, after, path);
    outputs.set(path, text);
    changes.push({ path, key: 'Gecko display branding', after: branding.displayName });
  }

  const java = `${appPrefix}main/java/org/mozilla/fenix/`;
  const aboutPath = java + 'settings/about/AboutFragment.kt';
  outputs.set(aboutPath, replaceOnce(await source(aboutPath),
    'getString(R.string.about_whats_new, getString(R.string.firefox))',
    'getString(R.string.about_whats_new, getString(R.string.upstream_firefox_name))', aboutPath));

  const wordmarkPath = java + 'home/ui/Wordmark.kt';
  let wordmark = await source(wordmarkPath);
  wordmark = replaceOnce(wordmark, 'import androidx.compose.ui.graphics.ColorFilter\n', '', wordmarkPath);
  wordmark = replaceOnce(wordmark, 'import androidx.compose.ui.res.dimensionResource\n', '', wordmarkPath);
  wordmark = replaceOnce(wordmark, 'import androidx.compose.runtime.Composable', 'import androidx.compose.material3.Text\nimport androidx.compose.runtime.Composable', wordmarkPath);
  wordmark = replaceOnce(wordmark, 'import org.mozilla.fenix.R\n', 'import org.mozilla.fenix.R\nimport org.mozilla.fenix.theme.FirefoxTheme\n', wordmarkPath);
  const oldText = wordmark.slice(wordmark.indexOf('@Composable\ninternal fun WordmarkText'));
  if (!oldText.includes('painterResource(getAttr(R.attr.fenixWordmarkText))')) throw new Error('Unexpected wordmark implementation');
  wordmark = replaceOnce(wordmark, oldText, `@Composable
internal fun WordmarkText(color: Color?) {
    Text(
        modifier = Modifier.semantics {
            testTagsAsResourceId = true
            testTag = HOMEPAGE_WORDMARK_TEXT
        },
        text = stringResource(R.string.app_name),
        style = FirefoxTheme.typography.headline5,
        color = color ?: Color.Unspecified,
    )
}
`, wordmarkPath);
  outputs.set(wordmarkPath, wordmark);

  for (const relative of ['pbmlock/UnlockPrivateTabsScreen.kt', 'settings/biometric/ui/UnlockScreen.kt']) {
    const path = java + relative;
    const original = await source(path);
    outputs.set(path, replaceOnce(original, `        Image(
            modifier = Modifier.height(28.dp),
            painter = painterResource(getResolvedAttrResId(R.attr.fenixWordmarkText)),
            contentDescription = stringResource(R.string.app_name),
        )`, `        Text(
            text = stringResource(R.string.app_name),
            style = FirefoxTheme.typography.headline5,
        )`, path));
  }

  const layoutPath = `${appPrefix}main/res/layout/fragment_about.xml`;
  let layout = await source(layoutPath);
  layout = replaceOnce(layout, '<ImageView\n            android:id="@+id/wordmark"', '<TextView\n            android:id="@+id/wordmark"', layoutPath);
  layout = replaceOnce(layout, 'android:layout_height="@dimen/about_header_fenix_logo_height"', 'android:layout_height="wrap_content"', layoutPath);
  layout = replaceOnce(layout, 'android:importantForAccessibility="no"', 'android:accessibilityHeading="true"', layoutPath);
  layout = replaceOnce(layout, 'app:srcCompat="?fenixLogo"', 'android:text="@string/app_name"\n            android:textSize="32sp"\n            android:textStyle="bold"\n            android:textColor="?android:attr/textColorPrimary"\n            android:gravity="center"', layoutPath);
  outputs.set(layoutPath, layout);
  changes.push({ path: aboutPath, key: 'Release notes keep referring to upstream Firefox' });
  for (const path of [wordmarkPath, layoutPath, java + 'pbmlock/UnlockPrivateTabsScreen.kt', java + 'settings/biometric/ui/UnlockScreen.kt']) {
    changes.push({ path, key: 'Image wordmark replaced with accessible app-name text' });
  }
  return { displayName: branding.displayName, status: 'prepared; APK not rebuilt', changes, preserved };
}
