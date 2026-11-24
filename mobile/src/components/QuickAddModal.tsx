import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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

import { colors, elevation, fonts, radius, spacing } from '../theme';
import { MOTION, SpringPressable } from './Motion';

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

const SHEET_OFFSET = 380;

export function QuickAddModal({ visible, busy = false, error = null, onClose, onSubmit }: QuickAddModalProps) {
  const [mounted, setMounted] = useState(visible);
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [pasting, setPasting] = useState(false);

  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const sheetY = useRef(new Animated.Value(SHEET_OFFSET)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setInput('');
      setNote('');
      setTags('');
      backdropOpacity.setValue(0);
      sheetY.setValue(SHEET_OFFSET);

      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 210,
          easing: MOTION.easeOut,
          useNativeDriver: true,
        }),
        Animated.spring(sheetY, {
          toValue: 0,
          ...MOTION.springGentle,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 180,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(sheetY, {
          toValue: SHEET_OFFSET,
          duration: 190,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, backdropOpacity, sheetY]);

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

  if (!mounted) return null;

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
        </Animated.View>

        <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetY }] }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>收入一条新剪藏</Text>
              <Text style={styles.subtitle}>粘贴链接或小红书分享口令，剩下的交给后台</Text>
            </View>
            <SpringPressable onPress={onClose} hitSlop={10} scaleTo={0.9} contentStyle={styles.closeButton}>
              <Ionicons name="close" size={18} color={colors.muted} />
            </SpringPressable>
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
                placeholder="粘贴链接或小红书分享口令…"
                placeholderTextColor={colors.faint}
                style={styles.input}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
              <SpringPressable
                onPress={pasteFromClipboard}
                disabled={pasting}
                scaleTo={0.93}
                style={styles.pasteAnchor}
                contentStyle={styles.pasteButton}
              >
                {pasting ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <>
                    <Ionicons name="clipboard-outline" size={13} color={colors.accent} />
                    <Text style={styles.pasteText}>粘贴</Text>
                  </>
                )}
              </SpringPressable>
            </View>

            <View style={styles.fieldGroup}>
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
            </View>

            <View style={styles.fieldGroup}>
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
            </View>

            {error ? (
              <View style={styles.formError}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={styles.formErrorText}>{error}</Text>
              </View>
            ) : null}

            <SpringPressable
              onPress={submit}
              disabled={!canSubmit}
              scaleTo={0.97}
              contentStyle={[styles.submitButton, !canSubmit && styles.submitDisabled]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <Text style={styles.submitText}>收入书房</Text>
              )}
            </SpringPressable>
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    maxHeight: '88%',
    ...elevation.floating,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
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
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12.5,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    marginTop: spacing.lg,
  },
  scrollContent: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  fieldGroup: {
    gap: 6,
  },
  inputWrap: {
    position: 'relative',
  },
  input: {
    minHeight: 92,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: 12,
    paddingBottom: 38,
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  pasteAnchor: {
    position: 'absolute',
    right: 10,
    bottom: 10,
  },
  pasteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentBorder,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pasteText: {
    color: colors.accent,
    fontSize: 11.5,
    fontWeight: '600',
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 2,
  },
  singleInput: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  submitButton: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    ...elevation.accent,
  },
  formError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.danger}33`,
    padding: 10,
  },
  formErrorText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  submitDisabled: {
    opacity: 0.38,
    shadowOpacity: 0,
    elevation: 0,
  },
  submitText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '600',
  },
});
