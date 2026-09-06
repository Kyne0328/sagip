import React, {useState} from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {
  EMERGENCY_TYPES,
  URGENCIES,
  type EmergencyType,
  type Urgency,
} from './src/emergency/types';
import {useEmergencyReports} from './src/emergency/useEmergencyReports';

const emergencyLabels: Record<EmergencyType, string> = {
  MEDICAL: 'Medical',
  FLOOD: 'Flood',
  FIRE: 'Fire',
  TRAPPED: 'Trapped',
  VIOLENCE: 'Violence / threat',
  OTHER: 'Other emergency',
};

const urgencyLabels: Record<Urgency, string> = {
  IMMEDIATE_DANGER: 'Immediate danger',
  NEED_ASSISTANCE: 'Need assistance',
};

export default function App() {
  const {reports, loading, saving, message, create} = useEmergencyReports();
  const [showForm, setShowForm] = useState(false);
  const [emergencyType, setEmergencyType] = useState<EmergencyType | null>(null);
  const [urgency, setUrgency] = useState<Urgency | null>(null);
  const latest = reports[0];

  const save = async () => {
    if (!emergencyType || !urgency) return;
    const result = await create({emergencyType, urgency});
    if (result) {
      setShowForm(false);
      setEmergencyType(null);
      setUrgency(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>SAGIP</Text>
        <Text style={styles.eyebrow}>NEED HELP?</Text>
        <Text style={styles.title}>Create an emergency SOS</Text>
        <Text style={styles.subtitle}>
          Your SOS is saved on this phone first. Internet is not required.
        </Text>

        {!showForm ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create SOS"
            style={styles.sosButton}
            onPress={() => setShowForm(true)}>
            <Text style={styles.sosButtonText}>SOS</Text>
            <Text style={styles.sosButtonSubtext}>Tap to report an emergency</Text>
          </Pressable>
        ) : (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>What is happening?</Text>
            <View style={styles.optionGrid}>
              {EMERGENCY_TYPES.map(type => (
                <OptionButton
                  key={type}
                  label={emergencyLabels[type]}
                  selected={emergencyType === type}
                  onPress={() => setEmergencyType(type)}
                />
              ))}
            </View>
            <Text style={styles.sectionTitle}>How urgent is it?</Text>
            {URGENCIES.map(item => (
              <OptionButton
                key={item}
                label={urgencyLabels[item]}
                selected={urgency === item}
                onPress={() => setUrgency(item)}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save SOS on this device"
              disabled={!emergencyType || !urgency || saving}
              onPress={() => {
                save();
              }}
              style={({pressed}) => [
                styles.saveButton,
                (!emergencyType || !urgency || saving) && styles.disabledButton,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save SOS now'}</Text>
            </Pressable>
          </View>
        )}

        {message ? (
          <View accessibilityRole="alert" style={styles.messageCard}>
            <Text style={styles.messageText}>{message}</Text>
          </View>
        ) : null}

        <View style={styles.statusCard}>
          <Text style={styles.sectionTitle}>Local SOS status</Text>
          {loading ? (
            <Text style={styles.statusText}>Checking this device…</Text>
          ) : latest ? (
            <>
              <Text style={styles.savedText}>Saved on this device</Text>
              {latest.deliveryState === 'SERVER_ACCEPTED' ? (
                <Text style={styles.acceptedText}>Server accepted</Text>
              ) : latest.deliveryState === 'PERMANENT_FAILURE' ? (
                <Text style={styles.failedText}>Delivery failed permanently</Text>
              ) : (
                <Text style={styles.pendingText}>Pending delivery</Text>
              )}
              <Text style={styles.statusText}>
                {emergencyLabels[latest.emergencyType]} · {urgencyLabels[latest.urgency]}
              </Text>
            </>
          ) : (
            <Text style={styles.statusText}>No SOS saved on this device yet.</Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function OptionButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected}}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.optionButton, selected && styles.optionButtonSelected]}>
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F7F5F0'},
  container: {padding: 24, gap: 16},
  brand: {fontSize: 18, fontWeight: '800', letterSpacing: 2, color: '#21302B'},
  eyebrow: {fontSize: 13, fontWeight: '800', letterSpacing: 1.4, color: '#8D2F2A', marginTop: 8},
  title: {fontSize: 32, lineHeight: 38, fontWeight: '800', color: '#18211E'},
  subtitle: {fontSize: 17, lineHeight: 25, color: '#4B5752'},
  sosButton: {minHeight: 190, borderRadius: 28, backgroundColor: '#B33A32', alignItems: 'center', justifyContent: 'center', padding: 24, marginVertical: 8},
  sosButtonText: {fontSize: 56, fontWeight: '900', color: '#FFFFFF', letterSpacing: 3},
  sosButtonSubtext: {fontSize: 16, fontWeight: '700', color: '#FFFFFF', marginTop: 8},
  card: {backgroundColor: '#FFFFFF', borderRadius: 20, padding: 18, gap: 12},
  sectionTitle: {fontSize: 18, fontWeight: '800', color: '#18211E', marginTop: 4},
  optionGrid: {gap: 10},
  optionButton: {minHeight: 52, borderWidth: 1.5, borderColor: '#BCC4C0', borderRadius: 14, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#FFFFFF'},
  optionButtonSelected: {borderColor: '#21302B', backgroundColor: '#E8ECEA'},
  optionText: {fontSize: 16, fontWeight: '600', color: '#35423D'},
  optionTextSelected: {fontWeight: '800', color: '#18211E'},
  saveButton: {minHeight: 58, borderRadius: 16, backgroundColor: '#21302B', alignItems: 'center', justifyContent: 'center', marginTop: 8},
  disabledButton: {opacity: 0.45},
  pressed: {opacity: 0.8},
  saveButtonText: {fontSize: 17, fontWeight: '800', color: '#FFFFFF'},
  messageCard: {borderRadius: 16, padding: 16, backgroundColor: '#E8ECEA'},
  messageText: {fontSize: 16, lineHeight: 23, fontWeight: '700', color: '#21302B'},
  statusCard: {borderRadius: 20, padding: 18, backgroundColor: '#FFFFFF', gap: 8, marginTop: 4},
  savedText: {fontSize: 18, fontWeight: '800', color: '#21302B'},
  pendingText: {fontSize: 16, fontWeight: '800', color: '#8A5B18'},
  acceptedText: {fontSize: 16, fontWeight: '800', color: '#1B6B38'},
  failedText: {fontSize: 16, fontWeight: '800', color: '#B33A32'},
  statusText: {fontSize: 15, lineHeight: 22, color: '#56615D'},
});
