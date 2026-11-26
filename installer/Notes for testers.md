# Lucent Raw: notes for testers

Thank you for trying Lucent Raw. This is an early version (0.1). It is a RAW photo editor and organiser that runs entirely on your computer: nothing is uploaded and there is no account.

## Before you start

- **Windows 10 or 11, 64-bit**, or **Linux** (a .deb and an AppImage are on the release page; Print and display profiles do not work there). There is no Mac version yet.
- **The installer is not signed**, so Windows SmartScreen will say "Windows protected your PC". Choose **More info**, then **Run anyway**. It installs for your user only and needs no administrator rights.
- **Your photos are never changed.** Edits are kept in the catalog, a small database inside the program's data folder. Even so, test on copies of photos you care about.
- **It is free.** There is no trial and no licence key.
- **Back up the catalog before updating**: Catalogs window > Automatic backups. The program does this by itself once a day and before any catalog upgrade.

## New in this build (Beta 1)

- **This is Lucent Raw Beta 1.** The "test" numbers are finished: what was test 20 is the first beta, with the same features. Beta 2, 3 and so on will follow. The program's update notice understands the new names, but copies older than Beta 1 do not, so this one needs to be installed by hand.

- **Export > Social media > Optimise for.** Pick Instagram (portrait 4:5, square or landscape), Story/Reel/TikTok 9:16, Facebook or LinkedIn, X, or Pinterest and every photo comes out at exactly that size, as a high quality sRGB JPEG sharpened for the screen, with no camera details or place in the file. **Fit** chooses between filling the frame (the edges are cropped, from the middle) and keeping the whole photo (bars of a colour you choose). The preview shows the result. Please try a few photos in each shape and tell me if the crop cuts a face or the colours look different on your phone.
- **Import > Include photos in sub-folders.** On by default, as before. Untick it to bring in only the photos in the folder you chose. What you pick is remembered for next time.

## Before that (test 19)

- **Lucent Raw is free.** The 30 day trial and the licence key are gone: nothing is locked and no key is needed. (The trial and key code are still in the program, switched off.)
- **"Buy the developer a coffee"** button in the header and in Preferences under Licence. It opens a PayPal donation page in your web browser; the program sends nothing. Giving is optional and buys nothing. (The page is made from the developer's PayPal address, so please try it and tell me if PayPal says it cannot take a donation.)
- The terms and conditions and the privacy policy are updated for all of this.

## Before that (test 18)

- **The program now tells you when a newer version is out.** When it starts (and you are online) it asks GitHub for the list of releases and shows a small notice in the header if there is a newer one; pressing it opens the release page in your web browser. Nothing is downloaded or installed by itself, and nothing about you or your photos is sent. It can be switched off in Preferences > Updates, where there is also a Check now button. The privacy policy and terms describe it.
- **Preferences > About now shows the exact build** (for example 0.1.0-test18).
- **Security testing:** a damaged sidecar file could crash the program (a stack overflow); damaged sidecars are now refused. The local AI connection's export no longer accepts a network share or a relative folder. 120 deliberately damaged RAW and JPEG files, the picture protocol and the AI connection were also tested hard and held.

## Before that (test 17)

- **Pimples, moles and specks are now removed.** In test 16 spots on the cheeks were left in: a safety margin switched the retouch off over much of the lower face. Spots lighter, darker or redder than the skin right round them are healed, and each is filled with the grain of clean skin beside it, so it does not look smoothed over. Beads, lashes, lips and glasses are left alone.
- **Lips and brows:** a new panel in Retouch, Lip colour and Eyebrows. Auto retouch uses a little of both.
- **Auto tone looks at faces:** when there are people in the picture the exposure is nudged towards the faces (by at most 0.4 of a stop).

## Before that (test 16)

- **Retouch is rebuilt again, and this time checked on studio headshots.** The earlier version softened the picture: it erased eyelashes, faded glasses frames and beads, greyed the skin and left smudged patches. Now it works on brightness only, so colour and pores stay; it evens blotches instead of blurring; and it keeps well clear of lashes, brows, lips, hair, glasses and jewellery.
- **Blemishes and pimples:** only small, roundish, isolated spots are healed (not nostrils, folds or strands), and each is filled with the grain of the skin beside it.
- **New Finish sliders:** Skin highlights (brings out the light on the forehead, nose and cheekbones) and Skin texture (brings out the pores). Auto retouch uses both.
- **Faster:** about 3 to 4 seconds on a 6 megapixel headshot, plus about 4 seconds the first time a face is seen (it was about 20).
- **Terms and conditions** are in Preferences under About, with the privacy policy.

## Before that (test 15)

- **The program file is now called Lucent Raw.exe** (it was penumbra.exe, the old working name). If you installed an earlier test build, uninstall it first (Settings > Apps) so the old penumbra.exe is not left behind. Your photos and catalog are kept.
- **Retouch:** the face is now found by a face-parsing model, so skin, hair, eyes, lips and brows are told apart properly (not just by ovals). New sliders: Even tone (dodge and burn), Shine and Even colour. Body skin now covers the neck from the same model.
- **People masks** (Masks panel): Face skin, Hair, Eyes, Eyebrows, Lips, Teeth, Neck and Clothes.
- **Auto tone** now adds a little saturation too, so photos are not left flat.
- **Security:** the catalog database library was updated to fix a reported memory-exposure bug.
- Retouch with Body skin on takes a couple of seconds on a large photo.

## Before that (test 14)

- **Zoom** works again: at 100% the picture was drawn shifted off to one side, so you could not move around it. It now fills the view; drag it, use the mouse wheel or two-finger swipe to move.
- **Navigator:** a new panel under Presets (at the top in Retouch). A small picture with a frame on the part you are viewing: click it to zoom in there, drag the frame or use the arrow keys to move around.

## Before that (test 13)

- **Retouch** is rebuilt with frequency separation: it evens out tone and keeps the pores, so the picture no longer looks smeared or muddy. New sliders: Detail size, Amount, Texture.
- **Body skin:** a new slider in the Skin panel smooths the neck, shoulders and arms (skin of the face's colour below the chin; clothes and hair are left alone). Auto retouch uses it too.
- **Face finding** now also finds faces on their side or upside down, and faces cut by the edge of the frame, and says how each face is turned (for example "turned 25° left"). Finding faces takes about 2 seconds. A face in full profile that is also half out of the frame can still be missed.
- **Auto tone** no longer looks hazy and flat: it adds contrast and vibrance, sets the black and white points from the picture, and does not darken blown-out whites to grey.

## Before that (test 12)

- **Look:** the installer now shows the Lucent Raw logo and dark banner, and the program shows the banner while it starts.

## Before that (test 11)

- **Retouch** was making photos look bad. It now smooths blotches and keeps the pores, works on dark skin (before, it barely touched it), and no longer turns eyelids orange or paints white dots. A new **Auto retouch** button in the face selector finds the faces and gives them a light, natural retouch.
- **Highlights** no longer darken the whole picture when you pull them down.
- **Sliders** move at half speed when you drag them (a tenth with Shift held), and the handle no longer jumps to where you click.
- **Privacy policy** is now in Preferences, under About.

## Before that (test 10)

- **Auto tone now keeps the Standard look**: it corrects the exposure and gently rescues bright and dark parts, and no longer changes contrast, whites, blacks or colour strength.
- If the program closes by itself, send the file `crash.log` from the folder `%APPDATA%\app.penumbra.dev` (a closing without a message may leave no file; then say what you were doing).

## Before that (test 9)

- **B BOT** no longer gives two exposure suggestions that overwrite each other, and shows how the photo looks to most people (a score out of 10, a rough guide).
- **Retouch**: a Find faces button appears where the sliders ask for a face.

## Before that (test 8)

- **Fixed:** portrait photos from Canon cameras (CR2) came out sideways in Develop, Export and the AI tools. Photos in the Library grid, Compare and the Export size box also fitted badly; the type is smaller and the sliders have more room.
- **Find dust** was healing real detail (letters on a banner). It is stricter now, but still over-eager on busy photos; please check every spot it adds and delete the wrong ones. It works best on plain sky.
- **Tried on real Canon EOS 600D photos by the maker:** AI denoise, depth, subject, object, near, far and sky masks, face and eye finding, crop, Compare, Survey, Book, Print, Copy as DNG. Not tried on real hardware: printers, a second screen, a camera tethered.
- **AI Enlarge is about seven times faster** than before, and still slow: roughly 1.5 minutes for a 2048-pixel photo and ten minutes for a full 18 megapixel photo on the maker's computer. It shows its progress. Use Smooth when you cannot wait.

## Earlier (test 4)

Since test 3 (see the user guide, chapter 16 and 16b). Almost all of it is new and has only been tried with pretend data or made-up pictures, not on real photos, cameras, printers or screens, so please test it on your own files:

- **AI**: AI Denoise (Photo menu), + Object, + Near and + Far masks with a Lens blur slider, adaptive presets, Find dust, Find eyes. The AI models are inside the program (about 300 MB more), and run offline.
- **Merges and conversion**: Merge to HDR, Merge to panorama, Copy as DNG on import, DNG as an export format. DNG has never been run on a real RAW file here.
- **Print**: the Print tab, then Print… (try Microsoft Print to PDF first, then a real printer).
- **Library**: Compare (C), Survey (N), stacks (Ctrl+G, S), auto-stack, smart previews, export and import of another catalog, a watched folder (try it with your camera's own tether program, with the "show each new photo" tick).
- **Develop**: soft proofing (give it a printer profile), profiles, before and after (Y), the eye on each panel, a second window (Window menu: please try it on a second screen).
- **Export**: details written into the file; open the pictures after exporting.
- **Sidecars**: reading Lightroom's develop settings from its .xmp files.
## What to try

1. Import a folder of photos (include some RAW files from your own camera). Note which cameras open and which do not.
2. Rate, flag and keyword some photos; use the filter bar and the Edits filter.
3. Edit in Develop: the Basic sliders, tone curve, colour mixer, detail, crop (including a ratio of your own), masks and presets. Use the icon row at the top of the right-hand column, and hold Alt to see the number shortcuts.
4. Retouch: spots, red eye, portrait tools. Ask B BOT for a second opinion on a photo.
5. Export a few photos with a border and the camera settings caption, with different layouts and letter weights.
6. Back up the catalog and restore from the list.
7. Close and reopen the program: everything should be where you left it.

## What is not built yet (so you need not report it)

- No Map, Slideshow or Web modules.
- No shutter control for tethering (only the watched folder), no cloud or mobile sync.
- No camera profiles or lens-correction database; Adobe presets and profiles are not read.
- "Enlarge" has a smooth and an AI method; AI Denoise works on the 8-bit picture, not the RAW data.
- Only the single-letter keyboard shortcuts can be changed (Preferences > Keyboard shortcuts).
- Not built: camera colour profiles, 16-bit export, a working colour space wider than sRGB.
- Photos from a few cameras cannot be read (the program says so instead of guessing).

## When something goes wrong

Please tell us: what you did, what you expected, what happened, the camera or file type, and a screenshot if you can. The program keeps a log at `%APPDATA%\app.penumbra.dev\` (the folder name is the program's internal identifier). Do not send your photos unless asked.
