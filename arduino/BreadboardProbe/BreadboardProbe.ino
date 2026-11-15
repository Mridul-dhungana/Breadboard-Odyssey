/*
  Breadboard Odyssey — ADC probe firmware
  Target: Arduino UNO / UNO Q (MCU side) over USB serial @ 115200

  Protocol (newline-terminated):
    MEAS A0   ->  VOLTS A0 4.98
    PING      ->  PONG

  Wire the breadboard nets to ADC pins (default map in python/arduino_bridge.py):
    A0 VCC, A1 GND sense, A2 OUT, A3 CTRL, A4 TIMING, A5 DISCHARGE
  Share GND with the circuit under test. Do not exceed 5 V on ADC pins.
*/

const float VREF = 5.0;
const int SAMPLES = 8;

void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }
  Serial.println(F("BreadboardProbe ready"));
}

float readVolts(int pin) {
  long sum = 0;
  for (int i = 0; i < SAMPLES; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  float counts = sum / float(SAMPLES);
  return (counts / 1023.0) * VREF;
}

int pinFromToken(const String& token) {
  String t = token;
  t.toUpperCase();
  if (t.startsWith("A") && t.length() >= 2) {
    int n = t.substring(1).toInt();
    if (n >= 0 && n <= 5) return A0 + n;
  }
  // bare number 0-5
  if (t.length() == 1 && isDigit(t.charAt(0))) {
    int n = t.toInt();
    if (n >= 0 && n <= 5) return A0 + n;
  }
  return -1;
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  line.toUpperCase();

  if (line == "PING") {
    Serial.println(F("PONG"));
    return;
  }

  if (line.startsWith("MEAS")) {
    int sp = line.indexOf(' ');
    String ch = (sp >= 0) ? line.substring(sp + 1) : "A0";
    ch.trim();
    int pin = pinFromToken(ch);
    if (pin < 0) {
      Serial.println(F("ERR bad_channel"));
      return;
    }
    float v = readVolts(pin);
    Serial.print(F("VOLTS "));
    Serial.print(ch);
    Serial.print(' ');
    Serial.println(v, 3);
    return;
  }

  Serial.println(F("ERR unknown_cmd"));
}

void loop() {
  static String buf;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (buf.length()) {
        handleLine(buf);
        buf = "";
      }
    } else {
      buf += c;
      if (buf.length() > 64) buf = "";
    }
  }
}
