# LLM Wiki Interview Assistant

A personal interview copilot built on top of [LLM Wiki](https://github.com/nashsu/llm_wiki).

It turns a local LLM Wiki knowledge base into an interview assistant: capture interview audio, transcribe both sides, detect interviewer questions, route project questions to the right project profile, and generate concise spoken-answer prompts from your own notes.

This repository is prepared for public release. It does not include private project profiles, personal transcripts, API keys, local paths, candidate names, company names, or private knowledge-base content.

## What It Adds To LLM Wiki

[LLM Wiki](https://github.com/nashsu/llm_wiki) provides the local-first knowledge base, document ingestion, search, chat, local API, and MCP foundation.

This project focuses on the interview layer:

- Live system-audio and microphone capture in the Tauri desktop app.
- Streaming ASR integration.
- Interview question detection from the rolling transcript.
- Optional project routing profiles for project-specific questions.
- Five answer template families: project overview, project method, project detail, knowledge questions, and coding questions.
- Markdown export for transcripts, detected questions, answers, routing diagnostics, and timing data.
- Resettable interview sessions for repeated mock or live interviews.

## How It Works

```text
System audio + Microphone
  -> Streaming ASR
  -> Transcript
  -> Question detection
  -> Project routing + question type
  -> Answer template
  -> LLM Wiki retrieval and answer generation
```

By default, system audio is treated as interviewer-side audio, and microphone audio is treated as candidate-side audio.

## Requirements

- Node.js 20+
- npm
- Rust and Cargo
- macOS permissions for microphone and screen/audio capture when using live interview mode

If Rust is missing, install it from [rustup.rs](https://rustup.rs/). On macOS, install Apple command line tools if the Rust build asks for a compiler:

```bash
xcode-select --install
```

## Install

Run commands from the repository root, the folder containing `package.json` and `src-tauri/`.

```bash
npm install
npm --prefix mcp-server ci
npm run mcp:build
npm run typecheck
```

## Run

Start the real desktop app:

```bash
npm run tauri -- dev
```

The first run may take a few minutes because Rust dependencies need to compile.

Optional web UI smoke test:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

The web UI is useful for checking that the React app loads, but native project access and audio capture require the Tauri desktop app.

Build a desktop release:

```bash
npm run build:desktop
npm run tauri -- build
```

## Quick Start

1. Open the desktop app with `npm run tauri -- dev`.
2. Create or open an LLM Wiki project.
3. Import interview materials in `Sources`, such as resume bullets, project summaries, metrics, design notes, Q&A notes, coding notes, or theory notes.
4. Configure `LLM Provider` in `Settings`.
5. Configure `Speech-to-text` in `Settings` if you want audio transcription.
6. Open `Interview Assistant`.
7. Optionally add `Project routing profiles` so project questions can be matched to your own sanitized projects.
8. Optionally edit `Answer templates` if you want a different spoken-answer style.
9. Use `Choose test audio file` and `Test with audio file` first.
10. After file testing works, use `Start live interview`.

Use headphones during live interviews to reduce duplicate capture of interviewer audio through the microphone.

## Project Routing Profiles

Project routing profiles are optional. They are only needed when you want project-related questions to lock onto a specific project context.

Each profile can include:

- Project name
- Aliases
- Core keywords
- Supporting keywords
- Tech or metric keywords
- Exclude keywords
- Keyword combinations

The public repository ships with no bundled profiles. Add only your own sanitized project keywords.

## Answer Templates

The assistant chooses an answer template by question type:

- Project overview
- Project method or solution
- Project detail deep dive
- Knowledge or theory
- Coding

Templates are editable in the UI and stored locally. Shorter templates usually produce faster live answers.

## Development

Common checks:

```bash
npm run typecheck
npm run test:mocks
npm --prefix mcp-server test
```

Rust checks:

```bash
cd src-tauri
cargo check
cargo test
```

Important paths:

```text
src/components/interview/       Interview Assistant UI
src/lib/interview-*.ts          Interview pipeline logic
src/stores/interview-store.ts   Interview session state
src-tauri/src/commands/         Native Tauri commands
mcp-server/                     MCP bridge to the local API
```

## Privacy

Treat interview data as sensitive. Do not publish:

- Real interview transcripts
- Resume source documents
- Private project notes
- Candidate or company names from private interviews
- API keys or ASR credentials
- Local absolute paths
- Real `.llm-wiki/` project metadata

## License

This project is licensed under the terms in [LICENSE](LICENSE).
