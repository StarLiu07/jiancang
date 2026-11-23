import type { Platform } from './types';

export const colors = {
  bg: '#0E1014',
  surface: '#171A21',
  surfaceAlt: '#1F232C',
  surfaceRaised: '#222733',
  border: '#2A2F3A',
  borderStrong: '#3A4150',
  text: '#F3F4F6',
  textSecondary: '#C3C8D4',
  muted: '#8E96A8',
  faint: '#5E6678',
  accent: '#FF6B4A',
  accentSoft: 'rgba(255, 107, 74, 0.14)',
  success: '#3DDC97',
  successSoft: 'rgba(61, 220, 151, 0.14)',
  warning: '#F5B544',
  warningSoft: 'rgba(245, 181, 68, 0.14)',
  danger: '#F05454',
  dangerSoft: 'rgba(240, 84, 84, 0.14)',
  info: '#5B9CFF',
  infoSoft: 'rgba(91, 156, 255, 0.14)',
  overlay: 'rgba(6, 8, 12, 0.72)',
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
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

interface PlatformMeta {
  label: string;
  color: string;
  softColor: string;
  short: string;
}

export const platformMeta: Record<Platform, PlatformMeta> = {
  xiaohongshu: {
    label: '小红书',
    color: '#FF2E4D',
    softColor: 'rgba(255, 46, 77, 0.14)',
    short: '红',
  },
  wechat: {
    label: '公众号',
    color: '#07C160',
    softColor: 'rgba(7, 193, 96, 0.14)',
    short: '微',
  },
  x: {
    label: 'X',
    color: '#E7E9EE',
    softColor: 'rgba(231, 233, 238, 0.12)',
    short: 'X',
  },
  web: {
    label: '网页',
    color: '#5B9CFF',
    softColor: 'rgba(91, 156, 255, 0.14)',
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
