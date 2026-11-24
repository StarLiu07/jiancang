import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

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
 * Editorial markdown renderer (headings / bullets / quotes / dividers).
 * Optimized for calm long-form dark-mode reading on the obsidian canvas.
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
                <View style={styles.bulletDot} />
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
    gap: 12,
  },
  h1: {
    color: colors.text,
    fontSize: 21,
    lineHeight: 30,
    fontWeight: '800',
    letterSpacing: -0.2,
    marginTop: spacing.md,
  },
  h2: {
    color: colors.text,
    fontSize: 18,
    lineHeight: 27,
    fontWeight: '700',
    letterSpacing: -0.1,
    marginTop: spacing.md,
  },
  h3: {
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 24,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  paragraph: {
    color: colors.textSecondary,
    fontSize: 15.5,
    lineHeight: 27,
    letterSpacing: 0.15,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingLeft: spacing.xs,
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accent,
    marginTop: 11,
  },
  bulletText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 26,
  },
  quote: {
    borderLeftWidth: 2.5,
    borderLeftColor: colors.accent,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  quoteText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 23,
  },
  divider: {
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.md,
  },
});
