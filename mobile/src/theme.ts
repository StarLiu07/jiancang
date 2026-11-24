import { Platform as RNPlatform, type ViewStyle } from 'react-native';

import type { Platform } from './types';

/**
 * Obsidian Glass design tokens — aligned with the frosted-card + coral-clamp app icon.
 *
 * Surface hierarchy (darkest -> lightest):
 *   bg (#090B0F) -> surface (#11151D) -> surfaceAlt (#141923)
 *   -> surfaceElevated (#171D29) -> surfaceRaised (#202736)
 */
export const colors = {
  // Canvas & layered surfaces
  bg: '#090B0F',
  bgElevated: '#0D1017',
  surface: '#11151D',
  surfaceAlt: '#141923',
  surfaceElevated: '#171D29',
  surfaceRaised: '#202736',

  // Translucent frosted layers
  glass: 'rgba(255, 255, 255, 0.045)',
  glassStrong: 'rgba(255, 255, 255, 0.085)',

  // Hairline light rims (replaces heavy opaque borders)
  borderSubtle: 'rgba(255, 255, 255, 0.055)',
  border: 'rgba(255, 255, 255, 0.085)',
  borderStrong: 'rgba(255, 255, 255, 0.14)',
  rimTop: 'rgba(255, 255, 255, 0.13)',

  // Typography ink ramp
  text: '#F5F7FA',
  textSecondary: '#C5CCD9',
  muted: '#8690A4',
  faint: '#596275',

  // Signature coral-vermilion focal accent (sole primary highlight)
  accent: '#FF6B4A',
  accentBright: '#FF8468',
  accentSoft: 'rgba(255, 107, 74, 0.13)',
  accentBorder: 'rgba(255, 107, 74, 0.34)',
  accentGlow: 'rgba(255, 107, 74, 0.22)',
  onAccent: '#180B07',

  // Disciplined semantic states (status feedback only)
  success: '#38D399',
  successSoft: 'rgba(56, 211, 153, 0.12)',
  warning: '#F0B348',
  warningSoft: 'rgba(240, 179, 72, 0.12)',
  danger: '#F25F5C',
  dangerSoft: 'rgba(242, 95, 92, 0.12)',
  info: '#64A1FF',
  infoSoft: 'rgba(100, 161, 255, 0.12)',

  overlay: 'rgba(4, 6, 10, 0.78)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 26,
  pill: 999,
} as const;

export const elevation: Record<'card' | 'hero' | 'floating' | 'accent', ViewStyle> = {
  card: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#000000',
      shadowOpacity: 0.28,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
    },
    default: {
      elevation: 3,
    },
  }),
  hero: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#000000',
      shadowOpacity: 0.45,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 12 },
    },
    default: {
      elevation: 8,
    },
  }),
  floating: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#000000',
      shadowOpacity: 0.42,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
    },
    default: {
      elevation: 10,
    },
  }),
  accent: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#FF6B4A',
      shadowOpacity: 0.34,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
    },
    default: {
      elevation: 8,
    },
  }),
};

interface PlatformMeta {
  label: string;
  color: string;
  softColor: string;
  short: string;
}

export const platformMeta: Record<Platform, PlatformMeta> = {
  xiaohongshu: {
    label: '小红书',
    color: '#FF4764',
    softColor: 'rgba(255, 71, 100, 0.13)',
    short: '红',
  },
  wechat: {
    label: '公众号',
    color: '#2CC974',
    softColor: 'rgba(44, 201, 116, 0.13)',
    short: '微',
  },
  x: {
    label: 'X',
    color: '#E6EAF2',
    softColor: 'rgba(230, 234, 242, 0.1)',
    short: 'X',
  },
  web: {
    label: '网页',
    color: '#64A1FF',
    softColor: 'rgba(100, 161, 255, 0.13)',
    short: '网',
  },
};

export const statusMeta: Record<string, { label: string; color: string; softColor: string }> = {
  pending: { label: '排队中', color: colors.warning, softColor: colors.warningSoft },
  processing: { label: '解析中', color: colors.info, softColor: colors.infoSoft },
  ready: { label: '已就绪', color: colors.success, softColor: colors.successSoft },
  partial: { label: '部分成功', color: colors.warning, softColor: colors.warningSoft },
  failed: { label: '抓取失败', color: colors.danger, softColor: colors.dangerSoft },
};
