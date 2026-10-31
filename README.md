# Signal from the Stars

A cooperative classroom game for the web. A message from a faraway planet was coming in when the space station's antenna broke. Players take turns scanning a star map for station parts, and every scan asks a question that **everyone** answers. Each part the crew repairs decodes more of the alien message. Repair every part before the questions run out to hear the whole message.

It runs entirely in the browser with no backend or database. Players connect directly to each other using [PeerJS](https://peerjs.com/). It is part of a bank of classroom game templates that share the same Teacher Mode, question file format and controls.

## How to play

1. The teacher clicks **Host a game**, enters the teacher PIN, and shares the 4-character room code or the **Copy join link**.
2. Students type their name (first name and last initial) and the room code, then click **Join game**.
3. The host picks the settings and clicks **Start the mission**.
4. On your turn, tap a dark tile on the star map to scan it. It flips to show a station part, a surprise, or stardust.
5. Every scan asks a question, and every player answers it. Each student sees only their own result.
6. Station parts repair the antenna and decode more of the message. Parts count whether or not answers were right: the questions are a check-in, and the whole class wins or loses together.
7. **Win:** repair every part. **Lose:** the questions (the signal window) run out first.

The host's browser runs the game, so if the host closes their tab the game ends. A student who refreshes or loses connection gets back in automatically as the same player.

## Question types

| Type | What students do |
| --- | --- |
| Multiple choice | Pick one of 2 to 4 answers |
| True/False | Pick True or False |
| Type the answer | Type a word or number (capitals, extra spaces and end punctuation don't matter; 4.0 = 4) |
| Word bank | Drag or tap words into the blanks in a sentence |
| Put in order | Drag or tap 3 to 6 items into order |
| Match | Drag or tap answers next to what they match (2 to 6 pairs) |
| Sort | Drag or tap items into 2 to 4 groups |

Every drag also works as **tap an item, then tap where it goes**, which is easier on tablets and for young students. Multi-part questions (word bank, order, match, sort) count as correct only when everything is right, and the report also shows partial credit.

**For K–2:** every question has a **Read aloud** button (it uses the device's built-in voice), emoji work anywhere in questions and answers, and the lobby has a **Big buttons and text** option.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Space theme and layout |
| `script.js` | Game logic, PeerJS networking and Teacher Mode |
| `question-set-template.xlsx` | Optional spreadsheet for writing question sets (not needed to run the game) |

Keep the files at the top level of the repository, and keep `index.html` named exactly that.

## Teacher Mode

- **Open it:** press `Alt+Shift+T`, or triple-click the invisible bottom-left corner of the page, then enter the PIN.
- **Question sets:** keep as many sets as you like (**New set**, **Rename**, **Duplicate**, **Delete set**). Duplicate is the quickest way to make an easier or harder version.
- **Add or edit:** pick a type, type the question, and fill in the answer boxes. The hint under the question explains each type.
- **Add many at once:** paste rows copied from the template (Type, Question, Answer 1 to Answer 6), or type multiple choice lines as `question => correct | wrong 1 | wrong 2 | wrong 3`.
- **Export file** saves the open set as a `.json` file. **Import file** accepts those `.json` files (from this game or Escape the Island) and `.csv` files from the template (UTF-8 or older Excel files, commas or semicolons). Imported questions are added to the open set.
- **Copy sets from Escape the Island** copies the Escape the Island sets saved in the same browser. It only reads them and never changes them.
- **Where questions live:** in that computer's browser (`localStorage`), never online. Use Export and Import to move them to another computer.

### Question set template

Fill in the yellow cells of `question-set-template.xlsx`, one question per row. The **Check** column says OK or explains what to fix. The **How to use** tab shows the format for each type, and the first 7 rows are examples you can keep or delete. Download the **Questions** tab as CSV (Google Sheets: File > Download > Comma Separated Values; Excel: File > Save As > CSV UTF-8), then use **Import file** in Teacher Mode. Rows that aren't marked OK are skipped and listed.

### How many questions

| Parts to repair | Star map | Questions for a fair game |
| --- | --- | --- |
| 6 (short) | 16 tiles | about 13 or more |
| 8 | 20 tiles | about 17 or more |
| 10 (standard) | 25 tiles | about 21 or more |
| 12 (long) | 30 tiles | about 26 or more |

These numbers give the team about a 9 in 10 chance to finish (found by simulating thousands of games). The lobby shows a gentle warning when a set is smaller, but you can still play.

## Host settings

**In the lobby:** question set (shown when you have more than one), parts to repair, random events (Off, Sometimes, Often), Team Power (On or Off), Big buttons and text, "I'm playing too" (uncheck to only facilitate), auto-advance, and the alien message the class decodes.

**During the game (Host controls):** auto-advance, projector-safe mode, settings for the next game, Whiteboard, **Next turn**, Class report and Restart. On the question card, the host can also tap a tile for a student who stepped away, press **Skip waiting** for a stuck student, and open the whiteboard. The win/lose screen repeats the next-game settings, because it covers Host controls.

**Projector-safe mode** is on by default. It hides student names and answers on the host's screen so nothing embarrassing appears on a projector. Turn it off (in Host controls or with the button on the question card) to see who answered what, and, when you're only facilitating, the answer key during the question.

### Random events

Some tiles hide a surprise for the whole team. All four kinds appear before any kind repeats, and none can end the game by itself.

- 👽 **Friendly alien:** a free part.
- ☄️ **Space junk:** the newest repair floats off to another tile on the map, so the team can find it again.
- ☀️ **Solar flare:** 2 fewer questions.
- 🚀 **Supply rocket:** 2 used questions go back in the pile (more time).

### Team Power

When at least two thirds of the crew get a question right, the Team Power meter fills one step. Three steps repair a bonus part. The meter only ever goes up, and nobody is singled out when it doesn't fill.

### Whiteboard

While a question is on screen, the host presses **Whiteboard** to draw (6 pen colors, 3 sizes, eraser, undo, clear) and **Show to class** to put the drawing on every student's screen. Students can close it and reopen it with the **Teacher's board** button in the corner. Auto-advance pauses while you use the whiteboard, and the drawing clears when the next turn starts.

### Class report

Every game records each student's answers on the host's device. Open it from **Class report** in Host controls, **View class report** on the win/lose screen, or **Last game report** in Teacher Mode. It shows student totals and, for each question, the percent correct and most common wrong answers (under 60% is highlighted). There are two downloads:

- **Answers (CSV):** one row per student per question, with their answer, the correct answer, the result and partial credit.
- **Summary (CSV):** student totals and question results, with questions under 60% marked NEEDS REVIEW.

The report shows which question set was used. It is saved only on the host's device, and each new game replaces it, so download it first if you need it. **Delete report** removes it from a shared computer.

## Changing the PIN

Open `script.js` and edit the `TEACHER_PIN` line near the top (it starts as `CHANGE-ME`). The PIN lives only in this file, never in the HTML or on screen. Anyone who opens the page source can read it, so it keeps students out of the menus but is not real security. Wrong PINs lock the prompt for 30 seconds after 5 tries.

## Host it for free on GitHub Pages

1. Create a **public** repository.
2. Upload `index.html`, `style.css` and `script.js` (not a zip file, and not inside a folder).
3. Go to **Settings > Pages**, set **Source** to **Deploy from a branch**, choose **main** and **/ (root)**, and click **Save**.
4. After a minute or two, the game is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

All of your games can live on the same GitHub account. Each game saves its data under its own name (`signalStars.…`), so games never overwrite each other's questions or reports.

## Technical notes

- Plain HTML, CSS and JavaScript; no build step. PeerJS 1.5.4 is loaded from `cdn.jsdelivr.net`.
- The host's browser is the single source of truth. After every change it sends each player their own snapshot with a rising revision number. Students only send requests.
- Students never receive other students' answers, and nobody receives the answer key until the reveal.
- Large messages are sent in 12,000-character pieces. Students send a heartbeat every 4 seconds; a student who is silent for 20 seconds is marked away and skipped, and keeps trying to reconnect for 30 seconds.
- If the PeerJS connection server drops, games in progress keep running and the host re-registers the room when the server returns.
- Storage keys: `signalStars.sets.v1`, `signalStars.report.v1`, `signalStars.message.v1`, `signalStars.name`; session keys `signalStars.token` and `signalStars.room`. A future format will use a new key and copy from the old one, never changing it, so rolling back is always safe.
- For local testing with your own PeerJS server, add `?peerhost=127.0.0.1&peerport=9000` to the address.

## Troubleshooting

- **Students can't join:** some school networks block WebRTC or the PeerJS server. Test from a student device on the school network first, and ask your IT team if it fails.
- **"Multiplayer library did not load":** the network may block `cdn.jsdelivr.net`.
- **A student got stuck:** press **Skip waiting** on the question, or tap a tile for a student who stepped away.
- **Room not found:** check the code with the host. It's 4 characters and never uses `0`, `O`, `1` or `I`.
- **Read aloud is silent:** the device has no built-in voice or the sound is off. Everything else still works.

## Credits

Built with plain HTML, CSS and JavaScript, plus [PeerJS](https://peerjs.com/) (MIT licensed). Fonts: Baloo 2 and Atkinson Hyperlegible from Google Fonts.
