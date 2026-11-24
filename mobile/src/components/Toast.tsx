import { Ionicons } from '@expo/vector-icons';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, elevation, radius, spacing } from '../theme';
import { MOTION } from './Motion';

export type ToastKind = 'success' | 'info' | 'error';

interface ToastState {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  show: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLE: Record<ToastKind, { color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  success: { color: colors.success, icon: 'checkmark-circle' },
  info: { color: colors.info, icon: 'information-circle' },
  error: { color: colors.danger, icon: 'alert-circle' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;
  const scale = useRef(new Animated.Value(0.94)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    if (!message) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToast({ id: Date.now(), message, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    opacity.setValue(0);
    translateY.setValue(16);
    scale.setValue(0.94);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: MOTION.easeOut,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, { toValue: 0, ...MOTION.springPop }),
      Animated.spring(scale, { toValue: 1, ...MOTION.springPop }),
    ]).start();

    hideTimer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 10,
          duration: 180,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.96,
          duration: 180,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setToast(null);
      });
    }, 2500);

    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [toast, opacity, translateY, scale]);

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);
  const kindStyle = toast ? KIND_STYLE[toast.kind] : KIND_STYLE.info;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.wrap,
            {
              bottom: insets.bottom + 84,
              opacity,
              transform: [{ translateY }, { scale }],
            },
          ]}
        >
          <View style={[styles.toast, { borderColor: `${kindStyle.color}40` }]}>
            <Ionicons name={kindStyle.icon} size={18} color={kindStyle.color} />
            <Text style={styles.text} numberOfLines={3}>
              {toast.message}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: '100%',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderTopColor: colors.rimTop,
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    ...elevation.floating,
  },
  text: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '600',
    lineHeight: 19,
    flexShrink: 1,
  },
});
