// Hands each block of microphone samples to the page, untouched.
// The AudioContext runs at 16 kHz, so the browser has already resampled.
class FoolscapCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor("foolscap-capture", FoolscapCapture);
