// Перевірки готової сторінки огляду: контракт Artifact і спільні вимоги верстки.

/** Перевірка контракту сторінки для публікації як приватного Artifact на claude.ai. */
export function checkArtifactContract(html: string): string[] {
  const problems: string[] = [];
  if (!html.startsWith('<meta name="claude:viewport-fit-sides" content="cover">')) problems.push('файл має починатися з meta claude:viewport-fit-sides');
  if (!/^<meta[^>]*>\s*<title>[^<]+<\/title>/.test(html)) problems.push('після meta має йти <title>');
  if (/<!doctype/i.test(html) || /<\/?(html|head|body)[\s>]/i.test(html)) problems.push('не можна мати теги doctype/html/head/body');
  return problems;
}

export function checkCommon(html: string): string[] {
  const problems: string[] = [];
  if (!/:root\[data-theme="dark"\]/.test(html)) problems.push('немає блоку :root[data-theme="dark"]');
  if (!/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/.test(html)) problems.push('немає блоку prefers-color-scheme: dark');
  if (!/padding-left:\s*max\(16px, env\(safe-area-inset-left, 0px\)\)/.test(html)) problems.push('немає бічного поля ліворуч');
  if (!/padding-right:\s*max\(16px, env\(safe-area-inset-right, 0px\)\)/.test(html)) problems.push('немає бічного поля праворуч');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const withoutTokens = css.replace(/:root\s*\{[^}]*\}/g, '').replace(/:root\[data-theme="dark"\]\s*\{[^}]*\}/g, '').replace(/:root:not\(\[data-theme="light"\]\)\s*\{[^}]*\}/g, '');
  if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(withoutTokens)) problems.push('у CSS є кольори поза токенами :root');
  // Медіа й стилі лише відносні; зовнішні гіперпосилання <a href="https://…"> дозволені (атрибуція фото).
  if (/\ssrc="(?:https?:)?\/\//.test(html) || /\ssrc="\//.test(html) || /<link[^>]*\shref="(?:https?:|\/)/.test(html) || /<a\s[^>]*href="(?:\/\/|\/)/.test(html)) problems.push('є абсолютні або зовнішні посилання на медіа чи стилі, дозволені лише відносні');
  return problems;
}

