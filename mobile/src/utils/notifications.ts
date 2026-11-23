import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const REVIEW_CHANNEL_ID = 'jiancang-daily-review';
export const DAILY_REMINDER_ID = 'jiancang-daily-review-reminder';

/**
 * Local-only reminders: no push tokens involved, so this stays safe in Expo Go
 * (Expo Go on Android cannot do remote push, but scheduled local notifications work).
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.canAskAgain === false) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

async function ensureReviewChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(REVIEW_CHANNEL_ID, {
    name: '每日回顾提醒',
    description: '提醒你消化今天该回顾的剪藏',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 180, 120, 180],
  });
}

export async function cancelDailyReviewReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(DAILY_REMINDER_ID);
  } catch {
    // Nothing scheduled / module unavailable: nothing to cancel.
  }
}

/** Schedules a repeating local notification at `hour:minute` every day. */
export async function scheduleDailyReviewReminder(hour: number, minute: number): Promise<boolean> {
  const granted = await ensureNotificationPermission();
  if (!granted) return false;

  await ensureReviewChannel();
  await cancelDailyReviewReminder();

  const trigger: Notifications.DailyTriggerInput = {
    type: Notifications.SchedulableTriggerInputTypes.DAILY,
    hour: Math.min(23, Math.max(0, Math.round(hour))),
    minute: Math.min(59, Math.max(0, Math.round(minute))),
    ...(Platform.OS === 'android' ? { channelId: REVIEW_CHANNEL_ID } : {}),
  };

  await Notifications.scheduleNotificationAsync({
    identifier: DAILY_REMINDER_ID,
    content: {
      title: '今日回顾时间到',
      body: '花几分钟消化几条剪藏，让收藏真正变成自己的知识。',
      sound: 'default',
    },
    trigger,
  });
  return true;
}

/** Applies the persisted reminder settings (idempotent). */
export async function syncDailyReviewReminder(enabled: boolean, hour: number, minute: number): Promise<boolean> {
  if (!enabled) {
    await cancelDailyReviewReminder();
    return true;
  }
  return scheduleDailyReviewReminder(hour, minute);
}

export async function hasScheduledDailyReminder(): Promise<boolean> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    return scheduled.some((item) => item.identifier === DAILY_REMINDER_ID);
  } catch {
    return false;
  }
}
