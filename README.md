# SmallTalk

<img src="frontend/img/smalltalk-180.png" width="64" alt="SmallTalk logo">

**It hears what the other person loves, builds their taste with Qloo, and tells you what to say next. On display glasses, a Quest headset, or a phone on the table.**

![SmallTalk home](docs/smalltalk-home.png)

**Try it:** https://smalltalk-flax.vercel.app

## Judge in 60 seconds

1. Open the site and click **Play the sample conversation** (or open `/?demo=sample`). A real recorded first coffee replays line by line.
2. Watch **They love**, **You share** and **Steer clear** fill in as they mention Sally Rooney, Phoebe Bridgers, Past Lives and Lisbon.
3. Read **Say next**: three things you could say, each tied to a Qloo result. A nudge that isn't from Qloo is marked.
4. When it finishes, click **Without Qloo?**: an LLM alone, given the same conversation, and how many of its suggestions actually fit their taste.
5. Click **Glasses view** for the one-nudge, white-on-black view for display glasses.

SmallTalk is shown in a live demo on a Quest headset rather than an edited video.

![SmallTalk during the sample conversation](docs/smalltalk-live.png)

## Where Qloo comes in

```
what they say ──► speech to text ──► the names they mention
                                         │  /search (names), /v2/tags (genres)
                                         ▼
          Qloo /v2/insights, signal.interests.entities = what they love
          ├─ what people with that taste also love (music, films, TV, books, podcasts, brands, places)
          └─ + your own favourites, feature.explainability = what you both drive (common ground)
                                         │
                                         ▼
          three short nudges, citing only names Qloo returned
```

| Step | Qloo call |
|---|---|
| Find what they mention | `GET /search?query=…&types=urn:entity:<kind>`; a hit only counts if it shares a real word with what was said |
| Genres they like or avoid ("superhero films") | `GET /v2/tags?filter.query=…`, kept as tags, never matched to a title |
| What people with their taste also love | `GET /v2/insights?filter.type=urn:entity:<type>&signal.interests.entities=<their entities>` |
| What you have in common | the same, signalled by both of you, with `feature.explainability=true`; a pick counts as shared when both sides drive at least a quarter of it |

## With and without Qloo

**Without Qloo?** sends the same conversation to an LLM with no tools and asks what to bring up next. Each suggestion is checked against what Qloo returned for their taste. In the recorded sample, **1 of 6** fits (Aftersun). The others are real (Mitski, Fleabag, Sintra) but not what people with this taste rate.

## Consent and privacy

- It will not listen until you tick that the other person knows you are using a conversation assistant.
- Audio goes in 6-second chunks to speech to text (ElevenLabs, via fal) and is not stored.
- Qloo receives names of things (bands, films, places), never names of people in the conversation, and its results describe crowds, not individuals.

## Three ways to see it

- **Phone or laptop:** the full view.
- **Glasses view:** one nudge, huge, white on black, for display glasses mirroring a phone.
- **Enter AR / VR:** the nudges float in front of you in WebXR, with Quest passthrough when available ([`frontend/talk-xr.js`](frontend/talk-xr.js)). Hold the trigger while you speak.

## How the code is laid out

```
frontend/      what the browser loads: plain HTML, CSS and JavaScript, plus the images. No build step.
backend/
  server.js    a Node 22 HTTP server with no framework. It serves frontend/ and the API, and holds every key.
  lib/         where the work happens:
    talk.js       one conversation: hear a line, find what was mentioned in Qloo, update their taste and the nudges
    qloo.js       a small Qloo client
    llm.js        the OpenRouter client
    demos.js      the recorded sample conversation in backend/data/demos
    limits.js     per-visitor and daily limits
    http.js       fetch with timeouts, and key redaction in error messages
  data/        the recorded example runs
test/          node --test, against fake Qloo and LLM services, so no keys are needed
api/           the Vercel entry point: one function that hands every request to backend/server.js
```

The pages in `frontend/`:

- `talk.html, talk.js, talk.css`: the page: consent, listening, and the nudges
- `talk-xr.js`: the AR/VR view, loaded only when you enter it

The browser only ever talks to this server. Qloo, the model and speech to text are called from `backend/`, so no key reaches the page, and anything that costs money has a per-visitor limit (`backend/lib/limits.js`).

## Run it yourself

There are no dependencies to install. With Node 22 or newer:

```bash
npm start
```

Then open http://localhost:3303. The recorded examples work with no keys at all. For live runs, put these in a `.env` file next to `package.json`:

- `QLOO_API_KEY`: Qloo, for their taste and your common ground
- `OPENROUTER_API_KEY`: picks out what they mention and writes the nudges (a fast model by default; `LLM_FAST_MODEL` changes it)
- `FAL_KEY`: speech to text (ElevenLabs on fal). Without it you can still type what they said

```bash
npm test
```

## Deploy

`vercel.json` sends every request to `api/index.js`, so `vercel deploy` is enough. Add the same keys as environment variables in the project settings. Any host that runs Node works too: `npm start` listens on `PORT` when it is set.

## Tests

```
✔ talk: consent first, typed or transcribed lines become a Qloo taste profile, nudges cite Qloo names
✔ recorded examples replay without any API keys, and the pages load
```

The SmallTalk test ([`test/talk.test.js`](test/talk.test.js)) checks that nothing happens without consent; typed and transcribed lines both work; mentions resolve in Qloo; common ground comes from a combined signal with explainability; nudges not from Qloo are flagged; dislikes are kept apart; a disliked genre becomes a Qloo tag rather than a film with a similar name; the "without Qloo" picks get the right verdicts; and bad audio is refused.

## Known limitations

- It needs the other person to mention specific things. Small talk about the weather gives it nothing to work with.
- Speech to text can mishear names; you can type what they said instead.
- The AR/VR view was built for Quest's browser and has not yet been tested on a physical headset.

The session logic lives in [`backend/lib/talk.js`](backend/lib/talk.js).

## License

MIT. Built for the Qloo Agentic Hackathon, October 2026.
