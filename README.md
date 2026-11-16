# Muzan Interview Coder

A powerful tool designed to help solve coding problems by capturing screenshots and utilizing AI for analysis — plus live listening for spoken interview questions.

## Setup

1. Install dependencies with `npm install`, then launch with `npm start`.
2. On first launch, choose OpenAI, Anthropic, or OpenRouter, enter a model ID and your API key, then save.
3. Use **API key settings** in the bottom-left corner to change providers, models, or keys later. Each provider keeps its own saved key; leave the key field blank to reuse it. Changing it stops live listening and clears the pending transcript.

Provider keys and settings are encrypted with Electron's OS-backed `safeStorage` and saved in the app's user-data directory as `api-key.enc`. Keys are never loaded from `config.json`. If secure storage is unavailable, saving is disabled. API usage is billed by the selected provider. Saving checks required fields; authentication and model access are checked when making requests. Existing OpenAI-only saved keys are loaded automatically.

Screenshot answers work with all three providers when the selected model supports images. Model IDs are editable, including OpenRouter IDs such as `openai/gpt-4o-mini`.

**Live transcription still uses OpenAI.** Save an OpenAI key first to enable listening, then select any answer provider. Anthropic and OpenRouter keys are never sent to OpenAI. Without an OpenAI key, screenshot answers still work; listening prompts you to configure one.

`config.json` is optional and only controls model preferences:

```json
{
  "model": "gpt-4o-mini",
  "sttModel": "gpt-4o-mini-transcribe"
}
```

These are also the defaults when no config file exists.


> Running from a VS Code terminal? If the app exits immediately, VS Code may have set `ELECTRON_RUN_AS_NODE=1`; run `env -u ELECTRON_RUN_AS_NODE npm start`.

### Optional settings

| Key | Default | What it does |
| --- | --- | --- |
| `model` | `gpt-4o-mini` | Chat model used for answers. |
| `reasoningEffort` | `"low"` | Sent only for reasoning models (`gpt-5*`, `o*`). Lower = faster. Use `"minimal"` for the fastest answers, or `null` to not send it. |
| `maxTokens` | `16000` for reasoning models, else `5000` | Output budget. Reasoning tokens count toward this. |
| `sttModel` | `gpt-4o-mini-transcribe` | Live speech-to-text model. |
| `language` | `en` | Spoken language for transcription. |
| `echoCancellation` | `false` | Mic echo cancellation. Leave off if the interviewer's voice comes through your speakers, since echo cancellation can filter it out. |
| `historyTurns` | `3` | How many previous Q&A turns are sent, so follow-ups ("now make it O(n)") have context. `0` disables. |
| `transcriptWindowSeconds` | `90` | How much recent speech is kept for the next answer. |
| `screenshotMaxWidth` | `1920` | Screenshots are downscaled to this width and sent as JPEG. |
| `screenshotJpegQuality` | `80` | JPEG quality (1–100). |
| `shortcuts` | see below | Override any shortcut, e.g. `{ "shortcuts": { "screenshot": "Alt+Shift+S" } }`. Set one to `null` to disable it. |

## Usage

On macOS `CommandOrControl` means **Cmd**; on Windows/Linux it means **Ctrl**. The banner shows the actual keys.

### Live listening (spoken questions)
- **Cmd/Ctrl+Shift+V** (`listen`): Toggle the listen session on/off. The live transcript and a mic-level meter appear on the right.
- **Cmd/Ctrl+Shift+Enter** (`answer`): Answer now using the recent transcript plus any screenshots you captured. If someone is mid-sentence, it waits briefly for that last bit to finish transcribing. Press it again after an answer to ask a follow-up.

### Capture & process (on-screen / code)
- **Cmd/Ctrl+Shift+S** (`screenshot`): Take a screenshot and solve from images only (or finalize Multi-mode as image-only).
- **Cmd/Ctrl+Shift+A** (`multi`): Capture into **Multi-mode** without solving. Then use **Answer** to include spoken context, or **S** for image-only.

### Reading the answer
Answers stream in as they're generated, with syntax highlighting and a **Copy** button on each code block.
- **Cmd/Ctrl+Shift+J / K** (`scrollDown` / `scrollUp`): Scroll the answer.
- **Cmd/Ctrl+Shift+9 / 0** (`opacityDown` / `opacityUp`): Adjust window opacity.
- **Cmd/Ctrl+Shift+- / =** (`shrink` / `grow`): Resize the window.
- **Cmd/Ctrl+Shift+Arrow keys**: Move the window (hold to move continuously).

### Application control
- **Cmd/Ctrl+Shift+R** (`reset`): Cancel an in-progress answer and clear screenshots, transcript, conversation history and results. The listen session stays on.
- **Cmd/Ctrl+Shift+W** (`toggleWindow`): Hide/show the window.
- **Cmd/Ctrl+Shift+Q** (`quit`): Quit.

If a shortcut is already taken by another app, the banner tells you which one; remap it under `shortcuts` in `config.json`.

## How it works
1. Launch the app using `npm start`.
2. When the interview starts, press **listen** once.
3. For spoken questions: after the question is asked, press **answer**.
4. For on-screen problems or code to troubleshoot: **multi** (or **screenshot** for image-only solve). To combine speech and screen, capture with **multi**, then press **answer**.
5. The answer streams into the overlay window.

## Security notes
The overlay renders model output as HTML, and that output can echo text from screenshots. So the renderer runs sandboxed with context isolation (no Node access), output is sanitized with DOMPurify, and a Content-Security-Policy blocks remote scripts and images. Libraries are bundled from `node_modules`, not loaded from a CDN.
