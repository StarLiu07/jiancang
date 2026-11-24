import { Platform as RNPlatform, type ViewStyle } from 'react-native';

import type { Platform } from './types';

/**
 * 「清晨折页」暖纸书房色板 — 宣纸米白、绵白纸页、松烟墨、印泥朱砂。
 *
 * Surface hierarchy:
 *   bg (#F6F2E8) — 宣纸底
 *   sheet / surfaceElevated (#FCF9F2) — 绵白纸页
 *   surface (#EFE9DC) — 浅米灰功能层
 *   surfaceAlt / surfaceRaised (#E6DFCF) — 沉降纸层
 */
export const colors = {
  // Canvas & warm paper layers
  bg: '#F6F2E8',
  sheet: '#FCF9F2',
  surface: '#EFE9DC',
  surfaceAlt: '#E6DFCF',
  surfaceElevated: '#FCF9F2',
  surfaceRaised: '#E6DFCF',

  // Subtle ink hairlines
  borderSubtle: 'rgba(31, 28, 24, 0.10)',
  border: 'rgba(31, 28, 24, 0.14)',
  borderStrong: 'rgba(31, 28, 24, 0.18)',

  // Typography ink ramp
  text: '#1F1C18',
  textSecondary: '#524B42',
  muted: '#867C70',
  faint: '#A39888',

  // Signature vermilion-coral seal accent
  accent: '#D44E30',
  accentDeep: '#B93E22',
  accentSoft: 'rgba(212, 78, 48, 0.09)',
  accentBorder: 'rgba(212, 78, 48, 0.28)',
  onAccent: '#FFFBF7',

  // Low-saturation semantic states
  success: '#3E7A58',
  successSoft: 'rgba(62, 122, 88, 0.10)',
  warning: '#B7832B',
  warningSoft: 'rgba(183, 131, 43, 0.10)',
  danger: '#C0392B',
  dangerSoft: 'rgba(192, 57, 43, 0.10)',
  info: '#496A88',
  infoSoft: 'rgba(73, 106, 136, 0.10)',

  overlay: 'rgba(31, 28, 24, 0.36)',
} as const;

export const fonts = {
  serif: RNPlatform.select({ ios: 'Songti SC', default: 'serif' }) ?? 'serif',
  mono: RNPlatform.select({ ios: 'Menlo', default: 'monospace' }) ?? 'monospace',
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
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 22,
  pill: 999,
} as const;

export const elevation: Record<'card' | 'hero' | 'floating' | 'accent', ViewStyle> = {
  card: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#2D2416',
      shadowOpacity: 0.08,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 8 },
    },
    default: {
      elevation: 2,
      shadowColor: '#2D2416',
    },
  }),
  hero: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#2D2416',
      shadowOpacity: 0.09,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 10 },
    },
    default: {
      elevation: 3,
      shadowColor: '#2D2416',
    },
  }),
  floating: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#2D2416',
      shadowOpacity: 0.14,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
    },
    default: {
      elevation: 6,
      shadowColor: '#2D2416',
    },
  }),
  accent: RNPlatform.select<ViewStyle>({
    ios: {
      shadowColor: '#D44E30',
      shadowOpacity: 0.24,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
    },
    default: {
      elevation: 4,
      shadowColor: '#D44E30',
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
    color: '#C84B52',
    softColor: 'rgba(200, 75, 82, 0.10)',
    short: '红',
  },
  wechat: {
    label: '公众号',
    color: '#3E7A58',
    softColor: 'rgba(62, 122, 88, 0.10)',
    short: '微',
  },
  x: {
    label: 'X',
    color: '#3A3631',
    softColor: 'rgba(58, 54, 49, 0.10)',
    short: 'X',
  },
  web: {
    label: '网页',
    color: '#496A88',
    softColor: 'rgba(73, 106, 136, 0.10)',
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
