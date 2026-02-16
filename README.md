# OA Coder

A powerful tool designed to help solve coding problems by capturing screenshots and utilizing AI for analysis.

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

## Usage

Once the application is running, you can use the following global shortcuts:

### Capture & Process
- **Ctrl+Shift+S**: Take a screenshot and solve immediately (or finalize Multi-mode).
- **Ctrl+Shift+A**: Enter/Capture in **Multi-mode** (allows capturing multiple pages/sections).

### Application Control
- **Ctrl+Shift+R**: Reset the current process (clears screenshots and results).
- **Ctrl+Shift+W**: Toggle window visibility (Hide/Show).
- **Ctrl+Shift+Q**: Quit the application.

### Window Navigation
- **Ctrl+Shift+Up/Down/Left/Right**: Move the application window around the screen.

## How it Works
1. Launch the app using `npm start`.
2. Navigate to the coding problem you want to solve.
3. Use **Ctrl+Shift+S** (or **Ctrl+Shift+A** for multiple captures) to capture the problem.
4. The AI will process the image(s) and display the solution in the overlay window.
