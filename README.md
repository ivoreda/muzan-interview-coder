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

## Usage

Once the application is running, you can use the following global shortcuts:

### Live listening (spoken questions)
- **Ctrl+Shift+V**: Toggle listen session on/off (streams mic to live transcription; does not answer by itself).
- **Ctrl+Shift+Enter**: Answer now using the recent live transcript and any screenshots you explicitly captured for this question.

### Capture & Process (on-screen / code)
- **Ctrl+Shift+S**: Take a screenshot and solve immediately from images only (or finalize Multi-mode as image-only).
- **Ctrl+Shift+A**: Enter/Capture in **Multi-mode** (accumulate pages/sections without solving). Then use **Ctrl+Shift+Enter** to include spoken context, or **Ctrl+Shift+S** for image-only.

### Application Control
- **Ctrl+Shift+R**: Reset (clears screenshots, transcript buffer used for answering, and results). Listen session can stay on.
- **Ctrl+Shift+W**: Toggle window visibility (Hide/Show).
- **Ctrl+Shift+Q**: Quit the application.

### Window Navigation
- **Ctrl+Shift+Up/Down/Left/Right**: Move the application window around the screen.

## How it Works
1. Launch the app using `npm start`.
2. When the interview starts, press **Ctrl+Shift+V** once to start listening.
3. For spoken questions: after the interviewer asks, press **Ctrl+Shift+Enter**.
4. For on-screen problems or code to troubleshoot: **Ctrl+Shift+A** (or **S** for image-only solve). To fuse speech + screen, capture with **A**, then **Enter**.
5. The AI displays the solution in the overlay window.

Provider API references: [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [OpenRouter Chat Completions](https://openrouter.ai/docs/api/reference/overview).
