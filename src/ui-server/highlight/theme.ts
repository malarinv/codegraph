/**
 * The near-monochrome code theme (design spec §2.2).
 *
 * The colouring is deliberately almost absent: comments and strings recede,
 * keywords carry weight rather than hue, and the ONLY colour in the body is a
 * resolved call site. A six-colour syntax theme buries exactly the thing the
 * screen exists to show.
 *
 * ## Why the theme's colours are sentinels, not colours
 *
 * A TextMate theme classifies by mapping scopes to colours, so that is how the
 * classification is *expressed* — but the values here are placeholders that
 * mean "comment", "string", "keyword", "number", nothing. The server turns each
 * one back into a class name; the viewer paints it from a CSS custom property.
 *
 * That indirection is load-bearing, not decoration:
 *
 * * **One token stream serves both modes.** The viewer flips light/dark from
 *   `prefers-color-scheme` with no reload and no refetch. Baking `#6a675d` into
 *   the payload would make dark mode a second request for the same source, and
 *   would put the design tokens in two places at once.
 * * **Contrast is fixed where the tokens live.** `ui/src/app.css` owns the
 *   ramp; a colour change there cannot leave the server's copy behind.
 *
 * The sentinels are arbitrary but must be distinct and must never be a colour a
 * grammar could plausibly emit through some other path, hence the `#00000n`
 * block: TextMate themes only ever return values *this* theme defines.
 */

/** The classes a token can carry — the viewer's `TokenClass`, server side. */
export const TOKEN_CLASSES = ['other', 'ident', 'comment', 'string', 'keyword', 'number'] as const;

export type TokenClassName = (typeof TOKEN_CLASSES)[number];

/** Class name → its index in {@link TOKEN_CLASSES}, which is what the wire carries. */
export const CLASS_ID: Record<TokenClassName, number> = {
  other: 0,
  ident: 1,
  comment: 2,
  string: 3,
  keyword: 4,
  number: 5,
};

const FG_DEFAULT = '#000001';
const FG_COMMENT = '#000002';
const FG_STRING = '#000003';
const FG_KEYWORD = '#000004';
const FG_NUMBER = '#000005';

/** Sentinel foreground → the class it stands for. */
export const SENTINEL_CLASS: Record<string, TokenClassName> = {
  [FG_DEFAULT]: 'other',
  [FG_COMMENT]: 'comment',
  [FG_STRING]: 'string',
  [FG_KEYWORD]: 'keyword',
  [FG_NUMBER]: 'number',
};

/**
 * The theme itself.
 *
 * Scope selection follows the spec exactly: `comment` recedes furthest,
 * `string`/`constant.numeric` sit one step in, `keyword`/`storage` stay ink and
 * gain weight, everything else is ink. Nothing sets a background — a token that
 * painted its own would fight the hovered-line and hot-line tints the rails use
 * to point at it.
 */
export const MONO_THEME = {
  name: 'codegraph-mono',
  type: 'light' as const,
  fg: FG_DEFAULT,
  // TextMate wants a background; the viewer never reads it (the code block
  // paints `--paper`), and it must not equal a foreground sentinel.
  bg: '#ffffff',
  settings: [
    { settings: { foreground: FG_DEFAULT } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: FG_COMMENT } },
    {
      scope: [
        'string',
        'string.template',
        'punctuation.definition.string',
        'constant.character.escape',
      ],
      settings: { foreground: FG_STRING },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'keyword.other.unit'],
      settings: { foreground: FG_NUMBER },
    },
    {
      scope: ['keyword', 'keyword.control', 'storage', 'storage.type', 'storage.modifier'],
      settings: { foreground: FG_KEYWORD },
    },
    // `keyword.operator` is a keyword scope by name only: it covers `=`, `+`,
    // `=>` and `?.`. Weighting punctuation buys nothing and costs the calm the
    // rest of the block is built on, so it drops back to plain ink — while the
    // operators that are actually WORDS (`new`, `typeof`, `instanceof`, `in`)
    // keep their weight through the more specific rule below. Shiki resolves
    // the longest matching scope, so the order here is the order of rescue,
    // not of priority.
    { scope: ['keyword.operator'], settings: { foreground: FG_DEFAULT } },
    {
      scope: ['keyword.operator.expression', 'keyword.operator.word', 'keyword.operator.new'],
      settings: { foreground: FG_KEYWORD },
    },
  ],
};

/** The class a Shiki token's resolved colour stands for. */
export function classOf(color: string | undefined): TokenClassName {
  if (!color) return 'other';
  return SENTINEL_CLASS[color.toLowerCase()] ?? 'other';
}
