import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { MOTION } from '../../src/components/Motion';
import { colors } from '../../src/theme';

function TabIcon({
  name,
  focused,
}: {
  name: keyof typeof Ionicons.glyphMap;
  focused: boolean;
}) {
  const scale = useRef(new Animated.Value(focused ? 1 : 0.96)).current;
  const barScale = useRef(new Animated.Value(focused ? 1 : 0.4)).current;
  const barOpacity = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    if (focused) {
      scale.setValue(0.9);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, ...MOTION.springPop }),
        Animated.spring(barScale, { toValue: 1, ...MOTION.springSnappy }),
        Animated.timing(barOpacity, {
          toValue: 1,
          duration: 150,
          easing: MOTION.easeOut,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.spring(scale, { toValue: 0.96, ...MOTION.springSnappy }),
        Animated.timing(barOpacity, {
          toValue: 0,
          duration: 110,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(barScale, {
          toValue: 0.4,
          duration: 110,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [focused, scale, barScale, barOpacity]);

  return (
    <Animated.View style={styles.iconWrap}>
      <Animated.View
        style={[
          styles.activeBar,
          { opacity: barOpacity, transform: [{ scaleX: barScale }] },
        ]}
      />
      <Animated.View style={{ transform: [{ scale }] }}>
        <Ionicons name={name} size={20} color={focused ? colors.accent : colors.muted} />
      </Animated.View>
    </Animated.View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.borderSubtle,
          borderTopWidth: 1,
          height: 60,
          paddingTop: 5,
          paddingBottom: 7,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.2,
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '今日折页',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'book' : 'book-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: '收藏目录',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'file-tray' : 'file-tray-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'options' : 'options-outline'} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    width: 44,
    height: 30,
    paddingTop: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 顶部横线完全留在 iconWrap 内部，避免 Android TabBar 裁切或盖住顶边线
  activeBar: {
    position: 'absolute',
    top: 0,
    width: 18,
    height: 2,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
});
