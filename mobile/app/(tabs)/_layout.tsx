import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { MOTION } from '../../src/components/Motion';
import { colors, radius } from '../../src/theme';

function TabIcon({
  name,
  color,
  focused,
}: {
  name: keyof typeof Ionicons.glyphMap;
  color: string;
  focused: boolean;
}) {
  const scale = useRef(new Animated.Value(focused ? 1 : 0.94)).current;
  const pillScale = useRef(new Animated.Value(focused ? 1 : 0.7)).current;
  const pillOpacity = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    if (focused) {
      scale.setValue(0.86);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, ...MOTION.springPop }),
        Animated.spring(pillScale, { toValue: 1, ...MOTION.springSnappy }),
        Animated.timing(pillOpacity, {
          toValue: 1,
          duration: 160,
          easing: MOTION.easeOut,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.spring(scale, { toValue: 0.96, ...MOTION.springSnappy }),
        Animated.timing(pillOpacity, {
          toValue: 0,
          duration: 120,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(pillScale, {
          toValue: 0.75,
          duration: 120,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [focused, scale, pillScale, pillOpacity]);

  return (
    <Animated.View style={styles.iconWrap}>
      <Animated.View
        style={[
          styles.iconPillBg,
          { opacity: pillOpacity, transform: [{ scaleX: pillScale }] },
        ]}
      />
      <Animated.View style={{ transform: [{ scale }] }}>
        <Ionicons name={name} size={20} color={color} />
      </Animated.View>
    </Animated.View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.borderSubtle,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: {
          fontSize: 10.5,
          fontWeight: '600',
          letterSpacing: 0.2,
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '今日回顾',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'sparkles' : 'sparkles-outline'} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: '收藏库',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'albums' : 'albums-outline'} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'settings' : 'settings-outline'} color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    width: 44,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPillBg: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
});
