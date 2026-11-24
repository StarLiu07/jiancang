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
}

/**
 * Editorial markdown renderer (headings / bullets / quotes / dividers)
 * tailored for calm long-form reading on warm paper sheets.
 */
export function MarkdownText({ content, selectable = false }: MarkdownTextProps) {
  const blocks = parseBlocks(content);

  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case 'h1':
            return (
              <Text key={key} selectable={selectable} style={styles.h1}>
                {block.text}
              </Text>
            );
          case 'h2':
            return (
              <Text key={key} selectable={selectable} style={styles.h2}>
                {block.text}
              </Text>
            );
          case 'h3':
            return (
              <Text key={key} selectable={selectable} style={styles.h3}>
                {block.text}
              </Text>
            );
          case 'divider':
            return <View key={key} style={styles.divider} />;
          case 'quote':
            return (
              <View key={key} style={styles.quote}>
                <Text selectable={selectable} style={styles.quoteText}>
                  {block.text}
                </Text>
              </View>
            );
          case 'bullet':
            return (
              <View key={key} style={styles.bulletRow}>
                <Text style={styles.bulletDash}>—</Text>
                <Text selectable={selectable} style={styles.bulletText}>
                  {block.text}
                </Text>
              </View>
            );
          default:
            return (
              <Text key={key} selectable={selectable} style={styles.paragraph}>
                {block.text}
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 14,
  },
  h1: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 20,
    lineHeight: 29,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  h2: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 17.5,
    lineHeight: 26,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  h3: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 24,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  paragraph: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 28.5,
    letterSpacing: 0.2,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    paddingLeft: 2,
  },
  bulletDash: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 28.5,
  },
  bulletText: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    lineHeight: 28.5,
    letterSpacing: 0.2,
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
    backgroundColor: colors.surface,
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  quoteText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 24,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.md,
  },
});
