# Muzan Interview Coder

A powerful tool designed to help solve coding problems by capturing screenshots and utilizing AI for analysis — plus live listening for spoken interview questions.

## Setup

To use this program, you need to create a `config.json` file in the project root with your OpenAI API credentials:

1. Create a file named `config.json` in the root directory.
2. Add the following content, replacing `OPEN_AI_API_KEY` with your actual key:

```json
{
  "apiKey": "OPEN_AI_API_KEY",
  "model": "gpt-5-nano"
}
```

Optional: set `"sttModel": "gpt-4o-mini-transcribe"` (default) for live speech-to-text.

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
