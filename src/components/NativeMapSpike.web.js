// src/components/NativeMapSpike.web.js
// The native map library has no web build; the web crew app keeps its existing map.
import { Pressable, Text, View } from 'react-native';

export default function NativeMapSpike({ onClose }) { // jobs / initialJobId are ignored on web
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text>The native map test only runs in the Android app.</Text>
      <Pressable onPress={onClose}><Text style={{ color: '#173355', fontWeight: '600' }}>Close</Text></Pressable>
    </View>
  );
}
