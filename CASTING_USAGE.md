# Video Casting Usage Guide

## Overview

StageSplit now supports **video-only casting** to remote devices (Chromecast, Smart TVs, etc.) while keeping the mixed audio playback local to your computer. This is perfect for karaoke setups where you have:
- A computer/laptop connected to a PA system or speakers
- A TV/display on the wall for showing video

## How It Works

- **Video**: Cast to remote device (TV, Chromecast, etc.)
- **Audio**: Plays from your computer's speakers
- **Mixing**: All six fader controls continue to work in real-time
- **Sync**: Adjustable audio/video offset to compensate for network latency

## Usage Instructions

### 1. Load Your Karaoke File
- Click "Choose File" and select a six-stem MP4 file
- Wait for the file to load and mixer UI to appear

### 2. Initiate Casting
- Click the **📺 Cast** button in the header
- A browser dialog will appear showing available cast devices
- Select your Chromecast, Smart TV, or other compatible device
- Click "Cast" to begin

### 3. Adjust Audio/Video Sync (if needed)

When casting, a sync control panel appears below the video. If you notice the audio and video are out of sync:

**Using the Slider:**
- Drag the sync offset slider left or right
- Range: -500ms to +500ms
- Negative values = audio plays earlier
- Positive values = audio plays later

**Using Quick Buttons:**
- **Audio Earlier (-50ms)**: Makes audio play 50ms earlier (if video is ahead)
- **Reset**: Returns offset to 0ms
- **Audio Later (+50ms)**: Makes audio play 50ms later (if audio is ahead)

The sync adjustment applies immediately during playback.

### 4. Control Playback

All transport controls work normally while casting:
- **Play (▶)**: Start playback on both cast device and local audio
- **Pause (⏸)**: Pause both video and audio
- **Stop (⏹)**: Stop playback and return to beginning
- **Faders**: Adjust individual stem volumes in real-time

### 5. Disconnect Casting

- Click **Disconnect** button in the cast control panel
- Or click the cast icon in your browser's address bar and select "Stop casting"
- Video returns to local playback

## Browser Compatibility

The casting feature uses the **Remote Playback API**, which is supported in:

- ✅ **Chrome** (desktop and Android)
- ✅ **Microsoft Edge**
- ✅ **Opera**
- ❌ **Firefox** (not supported)
- ❌ **Safari** (not supported)

**Note:** If you try to cast in an unsupported browser, you'll see an error message: "Casting not supported in this browser. Try Chrome or Edge."

## Compatible Cast Devices

Works with any device that supports the Cast protocol:
- Google Chromecast (all generations)
- TVs with built-in Chromecast
- Android TV devices
- Roku devices (select models)
- Smart TVs with DLNA support

## Troubleshooting

### "No devices found"
- Ensure your computer and cast device are on the same Wi-Fi network
- Check that your cast device is powered on
- Try refreshing the device list by clicking Cast again

### Audio/Video Out of Sync
1. Use the sync offset slider to adjust timing
2. Start with small adjustments (±50ms)
3. Typical network latency: 100-300ms
4. If video is ahead of audio: click "Audio Earlier" or drag slider left
5. If audio is ahead of video: click "Audio Later" or drag slider right

### Casting Disconnects Randomly
- Check Wi-Fi signal strength
- Move router closer to cast device if possible
- Reduce other network traffic during performance

### Audio Doesn't Play Locally
- Check your computer's volume and audio output settings
- Ensure the correct audio device is selected in system preferences
- The video element is intentionally muted—audio comes from Web Audio API

## Advanced Setup: External Audio System

For professional karaoke setups:

1. **Connect computer to PA system**: Use audio interface, mixer, or direct line out
2. **Position cast device/TV**: Place where performers can see lyrics
3. **Adjust sync offset**: Account for both network latency AND audio processing delay
4. **Test before performance**: Load a song and verify sync with "Audio Earlier/Later" buttons

## Technical Notes

- Video casting uses approximately **1-3 Mbps** of network bandwidth
- Audio stays local, so fader latency remains <20ms
- Sync offset is stored in memory only (resets when disconnecting)
- The cast stream is video-only (original video track without embedded audio)

## Keyboard Shortcuts (Future Feature)

*Not yet implemented, but planned:*
- `Ctrl/Cmd + K`: Toggle casting
- `Ctrl/Cmd + [`: Audio earlier (50ms)
- `Ctrl/Cmd + ]`: Audio later (50ms)
- `Ctrl/Cmd + 0`: Reset sync offset

## See Also

- [CASTING_RESEARCH.md](CASTING_RESEARCH.md) - Technical research and alternative approaches
- [CLAUDE.md](CLAUDE.md) - Overall project architecture and development guide
