import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../theme';

type BlockKind = 'h1' | 'h2' | 'h3' | 'paragraph' | 'bullet' | 'quote' | 'divider';

interface Block {
  kind: BlockKind;
  text: string;
}

/** Strips the most common inline markdown markers so text stays readable. */
function cleanInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let inCodeFence = false;

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (!trimmed) continue;

    if (inCodeFence) {
      blocks.push({ kind: 'quote', text: line });
      continue;
    }
    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      blocks.push({ kind: 'divider', text: '' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const text = cleanInline(heading[2]);
      if (!text) continue;
      blocks.push({ kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text });
      continue;
    }

    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      const text = cleanInline(bullet[1]);
      if (text) blocks.push({ kind: 'bullet', text });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      const text = cleanInline(quote[1]);
      if (text) blocks.push({ kind: 'quote', text });
      continue;
    }

    const text = cleanInline(trimmed);
    if (text) blocks.push({ kind: 'paragraph', text });
  }

  return blocks;
}

interface MarkdownTextProps {
  content: string;
  selectable?: boolean;
  /**
   * Tighter rhythm for AI chat bubbles: smaller body type, shorter gaps and
   * shallower heading margins. Long-form callers keep the roomy default.
   */
  compact?: boolean;
}

/**
 * Editorial markdown renderer (headings / bullets / quotes / dividers)
 * tailored for calm long-form reading on warm paper sheets.
 */
export function MarkdownText({ content, selectable = false, compact = false }: MarkdownTextProps) {
  const blocks = parseBlocks(content);
  const s = compact ? compactStyles : styles;

  return (
    <View style={s.container}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case 'h1':
            return (
              <Text key={key} selectable={selectable} style={s.h1}>
                {block.text}
              </Text>
            );
          case 'h2':
            return (
              <Text key={key} selectable={selectable} style={s.h2}>
                {block.text}
              </Text>
            );
          case 'h3':
            return (
              <Text key={key} selectable={selectable} style={s.h3}>
                {block.text}
              </Text>
            );
          case 'divider':
            return <View key={key} style={s.divider} />;
          case 'quote':
            return (
              <View key={key} style={s.quote}>
                <Text selectable={selectable} style={s.quoteText}>
                  {block.text}
                </Text>
              </View>
            );
          case 'bullet':
            return (
              <View key={key} style={s.bulletRow}>
                <Text style={s.bulletDash}>—</Text>
                <Text selectable={selectable} style={s.bulletText}>
                  {block.text}
                </Text>
              </View>
            );
          default:
            return (
              <Text key={key} selectable={selectable} style={s.paragraph}>
                {block.text}
              </Text>
            );
        }
      })}
    </View>
  );
}

/**
 * One style factory for both rhythms so `compact` never drifts from the
 * long-form defaults (which stay byte-identical for existing callers).
 */
function createStyles(compact: boolean) {
  return StyleSheet.create({
    container: {
      gap: compact ? 8 : 14,
    },
    h1: {
      fontFamily: fonts.serif,
      color: colors.text,
      fontSize: compact ? 17.5 : 20,
      lineHeight: compact ? 25 : 29,
      fontWeight: '700',
      marginTop: compact ? spacing.sm : spacing.md,
    },
    h2: {
      fontFamily: fonts.serif,
      color: colors.text,
      fontSize: compact ? 16 : 17.5,
      lineHeight: compact ? 23.5 : 26,
      fontWeight: '700',
      marginTop: compact ? spacing.sm : spacing.md,
    },
    h3: {
      fontFamily: fonts.serif,
      color: colors.text,
      fontSize: compact ? 14.5 : 15.5,
      lineHeight: compact ? 22 : 24,
      fontWeight: '700',
      marginTop: compact ? 6 : spacing.xs,
    },
    paragraph: {
      color: colors.text,
      fontSize: compact ? 14 : 15,
      lineHeight: compact ? 23 : 28.5,
      letterSpacing: 0.2,
    },
    bulletRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: compact ? 7 : 9,
      paddingLeft: 2,
    },
    bulletDash: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: compact ? 12 : 13,
      lineHeight: compact ? 23 : 28.5,
    },
    bulletText: {
      flex: 1,
      color: colors.text,
      fontSize: compact ? 14 : 15,
      lineHeight: compact ? 23 : 28.5,
      letterSpacing: 0.2,
    },
    quote: {
      borderLeftWidth: 2,
      borderLeftColor: colors.borderStrong,
      backgroundColor: colors.surface,
      borderRadius: 6,
      paddingVertical: compact ? 7 : 10,
      paddingHorizontal: compact ? 10 : spacing.md,
    },
    quoteText: {
      color: colors.textSecondary,
      fontSize: compact ? 13 : 14,
      lineHeight: compact ? 21 : 24,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.borderSubtle,
      marginVertical: compact ? spacing.sm : spacing.md,
    },
  });
}

const styles = createStyles(false);
const compactStyles = createStyles(true);
