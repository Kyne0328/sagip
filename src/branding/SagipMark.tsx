import React from 'react';
import {StyleSheet, View} from 'react-native';

interface SagipMarkProps {
  size?: number;
}

export function SagipMark({size = 44}: SagipMarkProps) {
  const pinSize = Math.round(size * 0.58);
  const tailSize = Math.round(pinSize * 0.42);
  const plusThickness = Math.max(3, Math.round(pinSize * 0.14));
  const plusLength = Math.round(pinSize * 0.52);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="SAGIP locator pin with medical plus logo"
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
      ]}>
      <View
        style={[
          styles.pinTail,
          {
            width: tailSize,
            height: tailSize,
            bottom: Math.round(size * 0.08),
          },
        ]}
      />
      <View
        style={[
          styles.pinHead,
          {
            width: pinSize,
            height: pinSize,
            borderRadius: pinSize / 2,
            top: Math.round(size * 0.13),
          },
        ]}>
        <View
          style={[
            styles.plusHorizontal,
            {
              width: plusLength,
              height: plusThickness,
              borderRadius: plusThickness / 2,
            },
          ]}
        />
        <View
          style={[
            styles.plusVertical,
            {
              width: plusThickness,
              height: plusLength,
              borderRadius: plusThickness / 2,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#0F4C81',
    overflow: 'hidden',
  },
  pinHead: {
    position: 'absolute',
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#C9302C',
  },
  pinTail: {
    position: 'absolute',
    zIndex: 1,
    backgroundColor: '#C9302C',
    transform: [{rotate: '45deg'}],
  },
  plusHorizontal: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
  },
  plusVertical: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
  },
});
