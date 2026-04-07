#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" {
#include "opus.h"
#include "codec2.h"
#include "lpcnet.h"
#include "lpcnet_private.h"
}

namespace {

constexpr int kCodec2Mode = CODEC2_MODE_700C;
constexpr int kRelayPcmPayloadType = 98;

struct Features {
  double energy = 0.0;
  double pitchHz = 0.0;
  double voicedProbability = 0.0;
  double spectralTilt = 0.0;
};

struct SenderState {
  struct CODEC2 *codec2 = nullptr;
  LPCNetEncState *encoder = nullptr;
  LPCNetPLCState plc;
  FARGANState fargan;
  bool farganReady = false;
  int codec2Samples = 0;
  int codec2Bytes = 0;
  std::deque<std::array<float, NB_FEATURES>> bootstrapFeatures;
  std::array<float, FARGAN_CONT_SAMPLES> bootstrapPcm = {0};

  ~SenderState() {
    if (codec2) {
      codec2_destroy(codec2);
    }
    if (encoder) {
      lpcnet_encoder_destroy(encoder);
    }
  }
};

double clamp(double value, double minValue, double maxValue) {
  return std::max(minValue, std::min(maxValue, value));
}

std::string normalizeMode(const std::string &mode) {
  if (mode == "deep-plc" || mode == "fargan" || mode == "off") {
    return mode;
  }
  return "off";
}

std::string jsonEscape(const std::string &value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (const char ch : value) {
    switch (ch) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        escaped.push_back(ch);
        break;
    }
  }
  return escaped;
}

void skipWhitespace(const std::string &input, size_t &index) {
  while (index < input.size() && std::isspace(static_cast<unsigned char>(input[index]))) {
    index += 1;
  }
}

bool findValueBounds(const std::string &json, const std::string &key, size_t &start, size_t &end) {
  const std::string needle = "\"" + key + "\":";
  const size_t keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return false;
  }

  start = keyPos + needle.size();
  skipWhitespace(json, start);
  if (start >= json.size()) {
    return false;
  }

  const char first = json[start];
  if (first == '"') {
    end = start + 1;
    bool escaped = false;
    while (end < json.size()) {
      const char current = json[end];
      if (escaped) {
        escaped = false;
      } else if (current == '\\') {
        escaped = true;
      } else if (current == '"') {
        end += 1;
        return true;
      }
      end += 1;
    }
    return false;
  }

  if (first == '{' || first == '[') {
    const char open = first;
    const char close = (open == '{') ? '}' : ']';
    int depth = 0;
    bool inString = false;
    bool escaped = false;
    end = start;
    while (end < json.size()) {
      const char current = json[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (current == '\\') {
          escaped = true;
        } else if (current == '"') {
          inString = false;
        }
        end += 1;
        continue;
      }

      if (current == '"') {
        inString = true;
      } else if (current == open) {
        depth += 1;
      } else if (current == close) {
        depth -= 1;
        if (depth == 0) {
          end += 1;
          return true;
        }
      }
      end += 1;
    }
    return false;
  }

  end = start;
  while (end < json.size()) {
    const char current = json[end];
    if (current == ',' || current == '}' || current == ']') {
      break;
    }
    end += 1;
  }
  return end > start;
}

std::string extractRawValue(const std::string &json, const std::string &key) {
  size_t start = 0;
  size_t end = 0;
  if (!findValueBounds(json, key, start, end)) {
    return "";
  }
  return json.substr(start, end - start);
}

std::string extractStringField(const std::string &json, const std::string &key) {
  const std::string raw = extractRawValue(json, key);
  if (raw.size() < 2 || raw.front() != '"' || raw.back() != '"') {
    return "";
  }
  return raw.substr(1, raw.size() - 2);
}

bool extractBoolField(const std::string &json, const std::string &key, bool defaultValue = false) {
  const std::string raw = extractRawValue(json, key);
  if (raw == "true") {
    return true;
  }
  if (raw == "false") {
    return false;
  }
  return defaultValue;
}

double extractDoubleField(const std::string &json, const std::string &key, double defaultValue = 0.0) {
  const std::string raw = extractRawValue(json, key);
  if (raw.empty()) {
    return defaultValue;
  }
  try {
    return std::stod(raw);
  } catch (...) {
    return defaultValue;
  }
}

std::string formatDouble(double value) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(6) << value;
  std::string result = stream.str();
  while (!result.empty() && result.back() == '0') {
    result.pop_back();
  }
  if (!result.empty() && result.back() == '.') {
    result.pop_back();
  }
  if (result.empty()) {
    return "0";
  }
  return result;
}

void replaceNumericField(std::string &json, const std::string &key, double value) {
  size_t start = 0;
  size_t end = 0;
  if (!findValueBounds(json, key, start, end)) {
    return;
  }

  json.replace(start, end - start, formatDouble(value));
}

void replaceRawField(std::string &json, const std::string &key, const std::string &raw) {
  size_t start = 0;
  size_t end = 0;
  if (!findValueBounds(json, key, start, end)) {
    return;
  }

  json.replace(start, end - start, raw);
}

std::vector<unsigned char> parseByteArray(const std::string &raw) {
  std::vector<unsigned char> bytes;
  if (raw.size() < 2 || raw.front() != '[' || raw.back() != ']') {
    return bytes;
  }

  size_t index = 1;
  while (index < raw.size()) {
    skipWhitespace(raw, index);
    if (index >= raw.size() || raw[index] == ']') {
      break;
    }

    size_t valueEnd = index;
    while (valueEnd < raw.size() && raw[valueEnd] != ',' && raw[valueEnd] != ']') {
      valueEnd += 1;
    }

    try {
      const int value = std::stoi(raw.substr(index, valueEnd - index));
      bytes.push_back(static_cast<unsigned char>(clamp(value, 0, 255)));
    } catch (...) {
      bytes.push_back(0);
    }

    index = valueEnd;
    if (index < raw.size() && raw[index] == ',') {
      index += 1;
    }
  }

  return bytes;
}

std::string formatByteArray(const std::vector<unsigned char> &bytes) {
  std::ostringstream stream;
  stream << "[";
  for (size_t index = 0; index < bytes.size(); index += 1) {
    if (index > 0) {
      stream << ",";
    }
    stream << static_cast<int>(bytes[index]);
  }
  stream << "]";
  return stream.str();
}

std::vector<unsigned char> encodePcmPayload(const std::vector<opus_int16> &pcm) {
  std::vector<unsigned char> payload;
  payload.resize(pcm.size() * 2);
  for (size_t index = 0; index < pcm.size(); index += 1) {
    const uint16_t value = static_cast<uint16_t>(pcm[index]);
    payload[index * 2] = static_cast<unsigned char>(value & 0xff);
    payload[index * 2 + 1] = static_cast<unsigned char>((value >> 8) & 0xff);
  }
  return payload;
}

std::vector<opus_int16> upsample8kTo16k(const std::vector<opus_int16> &input) {
  std::vector<opus_int16> output;
  output.resize(input.size() * 2);
  for (size_t index = 0; index < input.size(); index += 1) {
    const int current = input[index];
    const int next = (index + 1 < input.size()) ? input[index + 1] : current;
    output[index * 2] = static_cast<opus_int16>(current);
    output[index * 2 + 1] = static_cast<opus_int16>((current + next) / 2);
  }
  return output;
}

std::vector<opus_int16> downsample16kTo8k(const std::vector<opus_int16> &input) {
  std::vector<opus_int16> output;
  output.resize(input.size() / 2);
  for (size_t index = 0; index < output.size(); index += 1) {
    const int first = input[index * 2];
    const int second = input[index * 2 + 1];
    output[index] = static_cast<opus_int16>((first + second) / 2);
  }
  return output;
}

void copyFeatureVector(std::array<float, NB_FEATURES> &target, const float features[NB_TOTAL_FEATURES]) {
  for (int index = 0; index < NB_FEATURES; index += 1) {
    target[index] = features[index];
  }
}

bool initializeSenderState(SenderState &state, std::string &error) {
  state.codec2 = codec2_create(kCodec2Mode);
  if (!state.codec2) {
    error = "codec2_create failed";
    return false;
  }

  state.codec2Samples = codec2_samples_per_frame(state.codec2);
  state.codec2Bytes = codec2_bytes_per_frame(state.codec2);
  state.encoder = lpcnet_encoder_create();
  if (!state.encoder) {
    error = "lpcnet_encoder_create failed";
    return false;
  }

  if (lpcnet_plc_init(&state.plc) != 0) {
    error = "lpcnet_plc_init failed";
    return false;
  }

  fargan_init(&state.fargan);
  return true;
}

bool maybeBootstrapFargan(SenderState &state) {
  if (state.farganReady || state.bootstrapFeatures.size() < 5) {
    return state.farganReady;
  }

  std::array<float, 5 * NB_FEATURES> bootstrap = {0};
  for (size_t index = 0; index < state.bootstrapFeatures.size(); index += 1) {
    for (int featureIndex = 0; featureIndex < NB_FEATURES; featureIndex += 1) {
      bootstrap[index * NB_FEATURES + featureIndex] = state.bootstrapFeatures[index][featureIndex];
    }
  }

  fargan_cont(&state.fargan, state.bootstrapPcm.data(), bootstrap.data());
  state.farganReady = true;
  return true;
}

void updateBootstrapHistory(SenderState &state, const std::vector<opus_int16> &pcm16k) {
  if (pcm16k.size() < FARGAN_CONT_SAMPLES) {
    return;
  }

  const size_t offset = pcm16k.size() - FARGAN_CONT_SAMPLES;
  for (int index = 0; index < FARGAN_CONT_SAMPLES; index += 1) {
    state.bootstrapPcm[index] = pcm16k[offset + index] / 32768.f;
  }
}

void updatePlcWithPcm(SenderState &state, const std::vector<opus_int16> &pcm16k) {
  for (size_t index = 0; index + LPCNET_FRAME_SIZE <= pcm16k.size(); index += LPCNET_FRAME_SIZE) {
    lpcnet_plc_update(&state.plc, const_cast<opus_int16 *>(&pcm16k[index]));
  }
}

std::vector<opus_int16> synthesizeConcealment(SenderState &state, int frameCount) {
  std::vector<opus_int16> concealed;
  concealed.resize(frameCount * LPCNET_FRAME_SIZE);
  for (int frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    lpcnet_plc_conceal(&state.plc, &concealed[frameIndex * LPCNET_FRAME_SIZE]);
  }
  updateBootstrapHistory(state, concealed);
  return concealed;
}

std::vector<opus_int16> synthesizeRegularFrame(SenderState &state, const std::vector<opus_int16> &pcm16k, std::string &strategy) {
  std::vector<opus_int16> synthesized;
  synthesized.resize(pcm16k.size());

  for (size_t offset = 0; offset + LPCNET_FRAME_SIZE <= pcm16k.size(); offset += LPCNET_FRAME_SIZE) {
    float features[NB_TOTAL_FEATURES] = {0};
    std::array<float, NB_FEATURES> reduced = {0};
    lpcnet_compute_single_frame_features(state.encoder, &pcm16k[offset], features, 0);
    copyFeatureVector(reduced, features);
    state.bootstrapFeatures.push_back(reduced);
    while (state.bootstrapFeatures.size() > 5) {
      state.bootstrapFeatures.pop_front();
    }

    if (!state.farganReady) {
      maybeBootstrapFargan(state);
    }

    if (state.farganReady) {
      fargan_synthesize_int(&state.fargan, &synthesized[offset], reduced.data());
      strategy = "fargan-synthesized-pcm";
    } else {
      std::copy(pcm16k.begin() + offset, pcm16k.begin() + offset + LPCNET_FRAME_SIZE, synthesized.begin() + offset);
      strategy = "fargan-bootstrap-pcm";
    }
  }

  updateBootstrapHistory(state, synthesized);
  updatePlcWithPcm(state, synthesized);
  return synthesized;
}

std::string buildMetadata(
    const std::string &mode,
    bool enhanced,
    const std::string &strategy,
    const std::string &opusVersion,
    const std::string &implementation = "native-opus") {
  std::ostringstream metadata;
  metadata << "{\"mode\":\"" << jsonEscape(mode) << "\",\"enhanced\":" << (enhanced ? "true" : "false")
           << ",\"implementation\":\"" << jsonEscape(implementation) << "\",\"nativeLibrary\":\"" << jsonEscape(opusVersion) << "\"";
  if (!strategy.empty()) {
    metadata << ",\"strategy\":\"" << jsonEscape(strategy) << "\"";
  }
  metadata << "}";
  return metadata.str();
}

}  // namespace

int main() {
  const std::string mode = normalizeMode(std::getenv("NEURAL_RELAY_MODE") ? std::getenv("NEURAL_RELAY_MODE") : "off");
  const std::string opusVersion = opus_get_version_string();
  std::unordered_map<std::string, std::unique_ptr<SenderState>> senders;

  std::cout << "{\"type\":\"ready\",\"mode\":\"" << jsonEscape(mode) << "\",\"runtime\":\"native-opus\",\"opusVersion\":\""
            << jsonEscape(opusVersion) << "\"}" << std::endl;

  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string messageType = extractStringField(line, "type");
    if (messageType == "shutdown") {
      break;
    }

    if (messageType != "process-frame") {
      continue;
    }

    const std::string requestId = extractStringField(line, "requestId");
    const std::string roomId = extractStringField(line, "roomId");
    const std::string senderId = extractStringField(line, "senderId");
    std::string frameJson = extractRawValue(line, "frame");
    const std::string senderKey = roomId + ":" + senderId;
    if (frameJson.empty()) {
      std::cout << "{\"type\":\"process-frame-result\",\"requestId\":\"" << jsonEscape(requestId)
                << "\",\"error\":\"Missing frame envelope\"}" << std::endl;
      continue;
    }

    if (frameJson.find("\"kind\":\"packet\"") == std::string::npos) {
      std::cout << "{\"type\":\"process-frame-result\",\"requestId\":\"" << jsonEscape(requestId)
                << "\",\"result\":{\"frame\":" << frameJson
                << ",\"metadata\":" << buildMetadata(mode, false, "", opusVersion) << "}}" << std::endl;
      continue;
    }

    if (mode == "fargan") {
      std::string packetJson = extractRawValue(frameJson, "packet");
      const bool concealed = extractBoolField(frameJson, "concealed", false);
      const std::vector<unsigned char> codec2Payload = parseByteArray(extractRawValue(packetJson, "payload"));

      auto &sender = senders[senderKey];
      if (!sender) {
        sender = std::make_unique<SenderState>();
        std::string error;
        if (!initializeSenderState(*sender, error)) {
          std::cout << "{\"type\":\"process-frame-result\",\"requestId\":\"" << jsonEscape(requestId)
                    << "\",\"error\":\"" << jsonEscape(error) << "\"}" << std::endl;
          continue;
        }
      }

      if (!concealed && static_cast<int>(codec2Payload.size()) != sender->codec2Bytes) {
        std::cout << "{\"type\":\"process-frame-result\",\"requestId\":\"" << jsonEscape(requestId)
                  << "\",\"error\":\"Unexpected Codec2 payload length\"}" << std::endl;
        continue;
      }

      std::vector<opus_int16> output16k;
      std::string strategy;

      if (concealed) {
        output16k = synthesizeConcealment(*sender, 2);
        strategy = "lpcnet-plc-conceal-pcm";
      } else {
        std::vector<opus_int16> decoded8k(sender->codec2Samples);
        codec2_decode(sender->codec2, decoded8k.data(), codec2Payload.data());
        const std::vector<opus_int16> upsampled16k = upsample8kTo16k(decoded8k);
        output16k = synthesizeRegularFrame(*sender, upsampled16k, strategy);
      }

      const std::vector<opus_int16> output8k = downsample16kTo8k(output16k);
      const std::vector<unsigned char> pcmPayload = encodePcmPayload(output8k);
      replaceRawField(frameJson, "payloadType", std::to_string(kRelayPcmPayloadType));
      replaceRawField(frameJson, "payload", formatByteArray(pcmPayload));

      std::cout << "{\"type\":\"process-frame-result\",\"requestId\":\"" << jsonEscape(requestId)
                << "\",\"result\":{\"frame\":" << frameJson
                << ",\"metadata\":" << buildMetadata(mode, true, strategy, opusVersion, "native-opus-codec2-fargan") << "}}" << std::endl;
      continue;
    }

    Features features;
    features.energy = extractDoubleField(frameJson, "energy", 0.08);
    features.pitchHz = extractDoubleField(frameJson, "pitchHz", 0.0);
    features.voicedProbability = extractDoubleField(frameJson, "voicedProbability", 0.0);
    features.spectralTilt = extractDoubleField(frameJson, "spectralTilt", 0.0);
    const bool concealed = extractBoolField(frameJson, "concealed", false);

    bool enhanced = false;
    std::string strategy;
    auto &senderSlot = senders[senderKey];
    if (!senderSlot) {
      senderSlot = std::make_unique<SenderState>();
    }
    if (mode == "deep-plc" && concealed) {
      features.energy = clamp(features.energy * 0.9, 0.0, 1.0);
      features.voicedProbability = clamp(features.voicedProbability, 0.0, 1.0);
      enhanced = true;
      strategy = "concealment-shaped-features";
    }

    replaceNumericField(frameJson, "energy", features.energy);
    replaceNumericField(frameJson, "pitchHz", features.pitchHz);
    replaceNumericField(frameJson, "voicedProbability", features.voicedProbability);
    replaceNumericField(frameJson, "spectralTilt", features.spectralTilt);

    std::cout << "{\"type\":\"process-frame-result\",\"requestId\":\"" << jsonEscape(requestId)
              << "\",\"result\":{\"frame\":" << frameJson
              << ",\"metadata\":" << buildMetadata(mode, enhanced, strategy, opusVersion) << "}}" << std::endl;
  }

  return 0;
}
