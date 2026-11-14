# Lucent Raw: notes for testers

Thank you for trying Lucent Raw. This is an early version (0.1). It is a RAW photo editor and organiser that runs entirely on your computer: nothing is uploaded and there is no account.

## Before you start

- **Windows 10 or 11, 64-bit.** There is no Mac or Linux version yet.
- **The installer is not signed**, so Windows SmartScreen will say "Windows protected your PC". Choose **More info**, then **Run anyway**. It installs for your user only and needs no administrator rights.
- **Your photos are never changed.** Edits are kept in the catalog, a small database inside the program's data folder. Even so, test on copies of photos you care about.
- **It is a 30 day trial.** After 30 days editing stops until a licence key is entered (Preferences > Licence). You will be given a tester key that unlocks everything; the key is checked on your computer and needs no internet.
- **Back up the catalog before updating**: Catalogs window > Automatic backups. The program does this by itself once a day and before any catalog upgrade.

## What to try

1. Import a folder of photos (include some RAW files from your own camera). Note which cameras open and which do not.
2. Rate, flag and keyword some photos; use the filter bar and the Edits filter.
3. Edit in Develop: the Basic sliders, tone curve, colour mixer, detail, crop (including a ratio of your own), masks and presets. Use the icon row at the top of the right-hand column, and hold Alt to see the number shortcuts.
4. Retouch: spots, red eye, portrait tools. Ask B BOT for a second opinion on a photo.
5. Export a few photos with a border and the camera settings caption, with different layouts and letter weights.
6. Back up the catalog and restore from the list.
7. Close and reopen the program: everything should be where you left it.

## What is not built yet (so you need not report it)

- No Map, Slideshow, Print or Web modules.
- No auto-detect of duplicates, no stacks, no tethering, no cloud or mobile sync.
- No camera profiles or lens-correction database; Adobe presets and profiles are not read.
- AI Denoise is not built; "Enlarge" has a smooth and an AI method.
- The folder list is flat (no tree), and folders cannot be moved or renamed from inside the program.
- Keyboard shortcuts cannot be changed.
- Photos from a few cameras cannot be read (the program says so instead of guessing).

## When something goes wrong

Please tell us: what you did, what you expected, what happened, the camera or file type, and a screenshot if you can. The program keeps a log at `%APPDATA%\app.penumbra.dev\` (the folder name is the program's internal identifier). Do not send your photos unless asked.
