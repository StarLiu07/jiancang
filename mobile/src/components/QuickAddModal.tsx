import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../theme';

export interface QuickAddPayload {
  input: string;
  user_note: string;
  tags: string[];
}

interface QuickAddModalProps {
  visible: boolean;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (payload: QuickAddPayload) => Promise<void> | void;
}

export function QuickAddModal({ visible, busy = false, error = null, onClose, onSubmit }: QuickAddModalProps) {
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [pasting, setPasting] = useState(false);

  useEffect(() => {
    if (visible) {
      setInput('');
      setNote('');
      setTags('');
    }
  }, [visible]);

  const canSubmit = input.trim().length > 0 && !busy;

  const pasteFromClipboard = async () => {
    setPasting(true);
    try {
      const text = await Clipboard.getStringAsync();
      if (text) setInput(text);
    } catch {
      // Clipboard access can be denied by the OS; keep the manual input usable.
    } finally {
      setPasting(false);
    }
  };

  const submit = () => {
    if (!canSubmit) return;
    void onSubmit({
      input: input.trim(),
      user_note: note.trim(),
      tags: tags
        .split(/[,，、;；#\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>快速剪藏</Text>
              <Text style={styles.subtitle}>粘贴链接或小红书口令，剩下的交给后端</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeButton}>
              <Ionicons name="close" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.inputWrap}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="https://xhslink.com/… 或一段分享文案"
                placeholderTextColor={colors.faint}
                style={styles.input}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
              <Pressable
                onPress={pasteFromClipboard}
                disabled={pasting}
                style={({ pressed }) => [styles.pasteButton, pressed && styles.pressed]}
              >
                {pasting ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <>
                    <Ionicons name="clipboard-outline" size={13} color={colors.accent} />
                    <Text style={styles.pasteText}>粘贴</Text>
                  </>
                )}
              </Pressable>
            </View>

            <Text style={styles.label}>一句备注</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="为什么想收藏？（可留空）"
              placeholderTextColor={colors.faint}
              style={styles.singleInput}
              editable={!busy}
              maxLength={500}
            />

            <Text style={styles.label}>初始标签</Text>
            <TextInput
              value={tags}
              onChangeText={setTags}
              placeholder="AI、设计、稍后实践（逗号或空格分隔）"
              placeholderTextColor={colors.faint}
              style={styles.singleInput}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />

            {error ? (
              <View style={styles.formError}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.danger} />
                <Text style={styles.formErrorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={submit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.submitButton,
                !canSubmit && styles.submitDisabled,
                pressed && canSubmit && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#1A0D08" />
              ) : (
                <>
                  <Ionicons name="add-circle" size={18} color="#1A0D08" />
                  <Text style={styles.submitText}>提交剪藏</Text>
                </>
              )}
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    maxHeight: '88%',
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: 3,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12,
  },
  closeButton: {
    padding: 4,
  },
  scroll: {
    marginTop: spacing.lg,
  },
  scrollContent: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  inputWrap: {
    position: 'relative',
  },
  input: {
    minHeight: 96,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    paddingBottom: 34,
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
    textAlignVertical: 'top',
  },
  pasteButton: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pasteText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  singleInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 13,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 14,
    marginTop: spacing.xs,
  },
  formError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: `${colors.danger}44`,
    padding: spacing.sm,
  },
  formErrorText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  submitDisabled: {
    opacity: 0.42,
  },
  submitText: {
    color: '#1A0D08',
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.8,
  },
});
