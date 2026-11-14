# Lucent Raw: User Guide

Version 0.1.0 (written 18 October 2026)

Lucent Raw is a program for looking after and editing your photos on your own computer. It works offline: no account, no cloud, nothing is sent anywhere. This guide explains what it can do and how to do it. It is written for photographers, not programmers.

> **A note on honesty.** Lucent Raw is still being built. Everything in this guide has been built and tested, but so far mostly on test pictures rather than on a real working library, so expect to find rough edges. Some things are only partly finished, and a few things you might expect from a program like this do not exist yet. Each section says so where it matters, and the chapter "What is not there yet" lists it all in one place. A separate file, `whats-built.md`, has the full built and not-built list.

## Contents

1. The most important idea: your photos are never changed
2. Starting the program
3. A tour of the window
4. Bringing photos in (Import)
5. Looking at and sorting your photos (Library)
6. Collections, keywords and details
7. Editing a photo (Develop)
8. Fixing details (Retouch)
9. Making a photo book (Book)
10. Getting photos out (Export)
11. Looking after your catalog
12. Preferences and previews
13. Letting an AI assistant help (AI connection)
14. Keyboard shortcuts
15. Problems and answers
16. New in the latest builds
17. What is not there yet

---

## 1. The most important idea: your photos are never changed

Lucent Raw keeps a **catalog**. The catalog is a small database that remembers, for every photo: where its file is, its stars, flags and colour labels, its keywords, its title and caption, and every edit you have made. **Your original photo files are not opened for writing, not renamed, not moved and not deleted by anything in this program.** When you edit a photo you are not changing the picture file; you are changing a list of instructions ("a little brighter, crop here") that is kept in the catalog and applied when the photo is shown or exported.

This means:

- You can try anything. An edit can always be undone, and the original is always there.
- The catalog is precious. It holds your ratings, keywords, edits and books. The photos themselves are safe in their folders, but without the catalog you would lose all of that. See chapter 11 to back it up.
- If you move, rename or delete a photo file yourself (in Windows Explorer), the catalog does not know. The photo then shows as **missing**. Chapter 11 explains how to connect it again.

The only things Lucent Raw ever writes next to your photos are things you ask for: copies when you import with "copy", sidecar files if you switch them on (chapter 11), and exported pictures in the folder you choose.

## 2. Starting the program

At the time of writing, a ready-to-install version of Lucent Raw (an installer you can double-click) **has not been made yet**. The program runs from the project folder by the person who is building it. If you are that person, the developer guide explains how to start it. Everything below describes the program once it is running.

The first time it starts it makes an empty catalog in its own folder (inside the Windows application data folder). It does not touch any photos until you import some.

## 3. A tour of the window

**Along the top** you see the name, then four tabs: **Library**, **Develop**, **Retouch** and **Book**, and at the right three round buttons:

- the **sun or moon** button: switches between dark and light mode (see below);
- the **sliders** button: Preferences (chapter 12);
- the **plug** button: AI connection (chapter 13);
- the **?** button: Help and keyboard shortcuts.

**The left panel** changes with the tab. In the Library it holds the Navigator (a preview of the selected photo), the Catalog (folders and what is shown), Collections, Keywords, and buttons for Import, Export, Virtual copy, Cull and Paste settings. In Develop it holds the History list; in Retouch, the history and the faces found; in Book, your books.

**The middle** shows your photos: a grid in the Library, one large photo in Develop and Retouch, the page you are laying out in Book.

**The right panel** holds the controls for what you are doing: metadata and keywords in the Library, the adjustment panels in Develop, the retouching tools in Retouch, the page and frame controls in Book.

**Along the bottom** is the **filmstrip**, a row of small pictures of the photos you are looking at. Click one to go to it. It is there in every tab except Book, where you can still drag pictures out of it onto a page.

Almost everything has a keyboard shortcut. Press **?** at any time for the list, and see chapter 14.

The look of the program (soft rounded corners and blue accents) is deliberate. It starts **dark**, because a dark surround lets the colours in your photos look right; press the sun or moon button at the top right for **light mode**, which suits a bright room. Preferences (chapter 12) also has "Match my computer", which follows your computer's own dark or light setting. Your choice is remembered.

## 4. Bringing photos in (Import)

In the Library, press **Import…**.

1. **Choose the folder or memory card** your photos are on.
2. You see small pictures of what is there. **Untick** any you do not want.
3. Choose how to bring them in:
   - **Add**: the photos stay where they are, and the catalog just learns where they are. Nothing is copied.
   - **Copy**: the photos are copied into a destination folder you choose, sorted into folders by date (year-month-day), and the catalog learns the copies. Use this for a memory card.
4. Press Import.

What it understands: JPEG, PNG and TIFF pictures, and RAW files from many cameras: Canon CR2 and CR3, Nikon NEF, Sony ARW, Olympus ORF, Panasonic RW2, Fujifilm RAF, Adobe DNG (which includes Leica), Pentax PEF, Samsung SRW, Hasselblad 3FR and FFF, and Leica RWL and the RAW files written by Leica and Panasonic compact cameras (the .RAW ending). Files tried so far on real cameras: Hasselblad CFV and H3D-39II, and Leica Digilux 2, D-Lux 3, V-Lux 1, M8 and M240. One Hasselblad file (an iXpress CF132 back) could not be read: the library that reads RAW files does not know that camera, and the file holds no ordinary preview picture either. Other file types are skipped and the import tells you how many.

Photos that are already in the catalog are not added a second time.

After an import the program makes small preview pictures in the background, so the grid fills in over a few seconds (a minute or two for a big card). You can carry on working while it does.

**Things to know.** The date folders are always named year-month-day; you cannot choose another style yet. There is no "move" option, and the program does not notice a memory card being inserted: you choose it yourself. RAW files from very new cameras, or from makers not in the list above, may not show a preview or may fail to open (see chapter 15).

### Copying and moving, names and folders

Choosing **Copy into a folder** or **Move into a folder** shows two more choices. **File names** is a pattern: {name} (the photo's own name), {date} (the day it was taken), {seq} (001, 002 …) and {camera}; for example {date}_{seq}. **Folders** chooses how the destination is divided: a folder a day (2026-10-19), year/month/day (2026/10/19), year then day, a folder a month, a folder a year, or none. **Move** copies each photo, reads the copy back and compares it with the original, and only then removes the original; if the copy does not match, the original is kept. The destination cannot be the folder you are importing from or one inside it.

## 5. Looking at and sorting your photos (Library)

### The grid and the single-photo view

The Library opens as a **grid** of small pictures. Press **E** (or double-click a photo) to see one photo large; **G** goes back to the grid. The arrow keys move between photos. The size slider under the grid changes the size of the pictures, and the sort choice puts them in order of the date taken, their name or their stars.

Each picture can show small marks: its number, its stars, a flag (P picked, X rejected), a colour bar, **edited** if it has edits, **! missing** if its file cannot be found, and **Copy 1**, **Copy 2** and so on for a virtual copy (see below). You can switch several of these off in the view options.

### Stars, flags and colour labels

These are how you go through a shoot and decide what to keep. They work on the selected photos, in the Library and in Develop.

- **Stars**: press 1 to 5. Pressing the same number again clears it; 0 clears it too.
- **Flags**: **P** picks, **X** rejects, **U** clears the flag.
- **Colour labels**: 6 red, 7 yellow, 8 green, 9 blue. (Purple is chosen with its coloured button.)

Select several photos first (click one, then Shift-click another for a range, Ctrl-click to add one, or Ctrl+A for all of them) and one key press marks them all.

### Finding photos (the filter bar)

**Edited or not edited.** On the Attribute tab, **Edits** shows only the photos that have edits (Edited) or only those without any (Not edited). Choose Edited, press Ctrl+A to select them all, and Export to send just the photos you worked on. It can be saved with your other filters.

Above the grid is the filter bar. It has three kinds of filter, and you can use them together:

- **Text**: type part of a file name, a camera name or a lens name.
- **Attribute**: show only photos with at least some stars, only picks or rejects, only a colour label.
- **Metadata**: pick a camera or lens from the lists the catalog has learned, a range of ISO, focal length or aperture, and a range of dates.

When the filter shows nothing, the grid says so and a button clears the filter.

### Folders

The Folders panel is a tree. The top line of each branch is the place you imported from; the folders inside it are nested below, and the small arrow beside a name opens or closes it (which are open is remembered). A line that only holds other folders, such as a year, shows how many photos are inside it altogether. Press a folder's name to see its photos. Right-click a folder for **Rename** and **Move**: the folder is renamed or moved on your disk and in the catalog in one step (put back if the catalog cannot be updated), the folders inside it follow, and the photos keep all their edits. A folder can only be moved inside the place it came from.
The **Catalog** panel on the left lists everything (All photographs) and each folder with how many photos are in it. Click one to show just that folder.

### Cull: finding photos you probably do not want

Press **Cull…** (in the left panel). Lucent Raw looks at the previews of the selected photos, or of everything shown if you have not selected several, and points out:

- photos that are **out of focus** (the sharpest part of the picture is still soft);
- photos that are **badly exposed** (very dark, or with large washed-out areas);
- **bursts and near-duplicates**: pictures taken within about a minute of each other that look almost the same, with the sharpest, best-exposed one marked as the best.

It only measures. Nothing is flagged until you press a button (select them, or flag them as rejected), and a flag can be undone. It is a helper, not a judge: it cannot see closed eyes, expressions or whether the moment was good. It can be wrong, so look before you reject.

### Virtual copies

Sometimes you want two versions of one photo: colour and black and white, or two different crops. A **virtual copy** is a second entry for the same photo. Select photos and press **Virtual copy** in the left panel (or Ctrl+' with the apostrophe key). Each gets a new entry, marked **Copy 1**, that:

- shares the original's file, so it takes no extra room on your disk;
- starts with the original's stars, flag, label, keywords, text, collections and edits;
- is independent from then on: change its edits or stars and the original does not change.

If you remove a photo from the catalog, its virtual copies go with it. Removing a virtual copy only removes that copy. Virtual copies are not given sidecar files (chapter 11). When you export a photo and its copy together, the second file gets a number added to its name.

### Removing photos from the catalog

Select photos and press **Delete**. A box asks you to confirm. This removes them from the **catalog** only: the files stay on your disk. Their stars, keywords and edits are lost, and so are any virtual copies of them.

## 6. Collections, keywords and details

### Collections

A collection is a named group of photos that you choose, like an album.

- **Quick Collection**: press **B** to put the selected photos in it, and **B** again to take them out. It is there for gathering photos as you go.
- **Collections**: press **+** in the Collections panel to make one. You can add the selected photos as you make it. Select a collection to see what is in it; the buttons under the list add the selected photos, take them out, rename, or delete the collection (the photos stay).
- **Target collection**: make one collection the target, and **Shift+B** adds the selected photos to it. Handy for "to edit later".

### Smart collections

A smart collection fills itself. You do not choose its photos; you write **rules**, and it holds whatever meets them, now and as your catalog changes. Press the **✦** button in the Collections panel.

1. Give it a name.
2. Choose whether a photo must meet **all** of the rules or **any one** of them.
3. Add rules. Each rule is a thing to look at, a test and a value, for example *Rating is at least 4 stars*, or *Camera contains Canon*, or *Date taken is in the last 30 days*.

You can use these things: rating, flag, colour label, keyword (the keyword or anything under it, or part of its name), file name, title, caption, creator or copyright, camera, lens, ISO, focal length, aperture, date taken, file type, whether it has edits, whether it is a virtual copy, whether its file is missing, and whether it is in a certain ordinary collection.

While you build it, a line tells you **how many photos meet the rules now**, and says in words if a rule cannot be answered (for example, a keyword rule with no keyword typed). A smart collection shows in the list with a "Smart" mark and a count that updates itself. You cannot add photos to it or take them out by hand; change its rules instead (**Edit rules…**, under the list). You can rename and delete it like any collection.

Limits: up to 12 rules, all joined the same way (all or any); you cannot group rules or say "is not".

### Keywords

Keywords are words that describe a photo (Beach, Family, Wedding). Select photos and type in the **Keywords** panel; separate several with commas. For a keyword under another, write them with the greater-than sign: `Places > Beach` makes Beach a keyword under Places (up to three levels). The panel shows which keywords the selected photos have and, if only some of the photos have a keyword, how many. Click a keyword in the **Keyword list** to show only those photos (including the ones under it).

### Details (metadata)

The **Metadata** panel shows the camera details the photo came with (camera, lens, shutter, aperture, ISO, date) and lets you write a **title**, **caption**, **creator** and **copyright**. When several photos are selected and they have different texts, the box says "Mixed values"; typing something replaces it on all of them.

Under **More details** are credit, source, place (street or site), city, state or region and country. To put the same details on many photos, fill them in once on one photo and press **Keep these details…**, name the preset, then select other photos and choose it from **Apply a preset…**. Presets are kept in this program on this computer. These extra details live in the catalog; they are not written into sidecar files yet.

Other kinds of detail (for example location, or the long list of professional IPTC fields) are not editable yet.

## 7. Editing a photo (Develop)

Select a photo and press **D**, or click the **Develop** tab. The photo appears large, with the adjustments on the right and the **History** list on the left. Every adjustment is saved as you make it; there is no Save button. Leaving Develop and coming back finds your edits still there.

**Useful basics.** Hold the **backslash (\\)** key to see the photo as it was before your edits. **Ctrl+Z** undoes, **Ctrl+Shift+Z** (or Ctrl+Y) redoes. **Double-click a slider's name** to put it back to its starting value. **Z** zooms to 100% so you can check sharpness. **J** shows blown highlights in red and crushed shadows in blue. The **Histogram** at the top of the right panel is a graph of the brightness and colours in the photo.

### The panels

- **Basic**: **Temperature** and **Tint** (colour warmth; the Tint slider is a line that shades from green at the far left to magenta at the far right, so you can see which colour you are adding), **Exposure**, **Contrast**, **Highlights**, **Shadows**, **Whites**, **Blacks**, and, under Presence, **Texture**, **Clarity**, **Dehaze**, **Vibrance** and **Saturation**. Texture brings out (or, below zero, smooths) the finest detail such as skin pores and fabric, keeping strong edges when smoothing. Clarity adds (or, below zero, softens) punch in the midtones. Dehaze takes a milky veil of haze out of a photo (or, below zero, adds one). They work on the brightness of the picture, not its colours, and each is one undoable step. Two buttons suggest settings: **Auto WB** (a white balance that neutralises a colour cast) and **Auto tone** (exposure, contrast, highlights, shadows, whites and blacks). Auto tone follows what Lightroom's Auto does, as measured on 30 photographs Lightroom had processed: the exposure follows how light the picture is, and the other settings (a little contrast, highlights pulled down, shadows lifted, whites, blacks and vibrance) are the same recipe on every photo, at half the strength Lightroom uses, because this program edits the picture the camera already rendered. It also sets Vibrance. They are only suggestions; you can undo or change them.
- **Tone curve**: a curve you shape by clicking to add points and dragging. Double-click a point to remove it.
- **Colour mixer**: change the hue, saturation and brightness of each colour on its own (for example, make blues deeper without touching skin).
- **Detail**: **Sharpening** (amount, radius, and edge masking so smooth areas stay smooth) and **noise reduction** (for brightness noise and colour noise).
- **Effects**: **vignette** (darken or lighten the corners) and **grain**.
- **Lens corrections**: straighten the distortion some lenses cause.
- **Transform**: correct leaning buildings, rotate and flip.
- **Crop**: press **C** to put a frame on the photo. Drag it, drag the corner points, choose a shape (the ratios for prints and screens, or free), tilt it with the angle slider. A grid helps you compose (rule of thirds, golden ratio, diagonals, or a fine grid; you can choose which in Preferences). Press **Esc** or **Enter** when you are done. **Zoom in just enough** removes an empty corner left by a tilt.
- **Enlarge**: see "Enlarging" below.
- **B BOT**: see "B BOT" below.

The **Fine-tune arrows** button beside the sliders adds small up and down arrows for tiny steps; hold one for a second and it keeps stepping.

### Getting around the panels

There are a lot of panels down the right-hand side, so there are four ways to move between them.

- **The row of icons at the top.** One icon for each panel (masks, basic, tone curve, colour mixer, detail, effects, lens corrections, transform, crop, enlarge). Press one and that panel opens, the others close, and the view moves to it. **Shift-click** opens it and leaves the others as they are. A small dot under an icon means the photo has changes in that panel; an icon that is lit means its panel is open.
- **Alt and a number.** Alt+1 to Alt+9 open or close the first nine panels of the right-hand column and move to them (Alt+Shift+1 to 9 do the same for the left-hand column). **Hold Alt** and the number appears beside each panel name. Alt+0 closes every panel in the column.
- **Alt-click a panel name** to open just that panel and close the others in its column.
- **Up, Down, Home and End** on a panel name move from name to name.

Which panels are open is remembered the next time you start the program.

### Masks: editing only part of a photo

The **Masks** panel lets you apply an adjustment to just one area. Add a mask, choose what it covers, then use the adjustments for that mask:

- **Linear** and **Radial**: a gradient across the photo, or an oval. Drag its handles to place it; the feather slider softens the edge.
- **Brush**: paint where you want the effect (a size, a feather and a flow; hold **Alt** or use the Erase button to remove paint).
- **Luminance** and **Colour range**: pick what to affect by how bright it is, or by a colour you click on in the photo.
- **Subject**, **Background** and **Sky**: let the program find them for you. **Subject** and **Background** use a built-in picture-recognition model that works offline; **Sky** works from the colours and position in the picture. These are good starting points, but the edges are not perfect (hair and thin branches especially). You can combine and refine them with the other mask types.

Masks can be combined by adding to or subtracting from each other, so you can build up a shape.

### History and snapshots

The **History** list on the left shows every step you took, with what changed. Click a step to go back to how the photo looked then. A **snapshot** saves a look you want to come back to; make one before a big change.

### Presets and copying settings

A **preset** is a saved set of adjustments you can apply to any photo (there are built-in ones, and you can save your own). **Copy settings…** lets you tick which groups of adjustments to carry to other photos (the crop is left out unless you tick it). Then select photos in the Library and press **Paste settings**, or paste onto the next photo in Develop, to give them all the same look.

### B BOT: a second opinion

**B BOT** looks at the photo and tells you what it measured, then offers fixes you can accept. It checks, for example, whether the **skin tones** on any faces are too red, yellow or dark, and whether the **exposure, highlights, shadows, contrast and colour balance** look off. Each fix is made by trying real adjustments and measuring the result, and each is one undoable step in the History.

B BOT is a set of measurements and rules, not a trained model: it does not learn your taste, it can miss faces seen from the side, and its idea of "correct" is an average one. Treat its suggestions as suggestions.

### Enlarging

Printing big, or cropping tight, can leave a photo too small. The **Enlarge** panel shows the size after your crop and lets you choose a bigger size (2 to 4 times) and a method: **Smooth** (a careful standard enlargement) or **AI** (a built-in picture-recognition model that invents plausible fine detail; slower). It shows a before and after of a small piece so you can judge. The enlarged picture is made when you export (chapter 10), and the original is untouched. AI enlargement can create detail that was not in the scene, so use it with care on photos where accuracy matters.

## 8. Fixing details (Retouch)

The **Retouch** tab is for small repairs. It shows the same large photo, with its own tools on the right. Edits made here and in Develop are one and the same set: you can switch tabs freely.

- **Spot removal**: click a dust spot or blemish to add a spot; the program chooses a source area to copy from, and you can drag the source elsewhere. Three modes: **Clone** (copies exactly), **Heal** (copies and matches the colour and brightness around it) and **Fill** (a built-in model paints in what should be there, so you can remove a person, a sign or a bin). Spots are round (up to about a third of the photo across for Fill). The first Fill of a spot takes a moment and is then remembered.
- **Red eye**: click an eye to fix red pupils.
- **Faces**: press **Detect faces** to find the faces in a group photo (it finds faces looking toward the camera; faces in profile may be missed). Select a face and use its panels for smoothing skin, brightening the eyes and whitening teeth, each with an amount slider. With two or more faces marked, **Select all faces** (above the list of faces) makes every slider change all of them together, which is quicker for a group photo; picking one face again goes back to editing that face alone. **Copy to all faces** instead copies one face's settings onto the others once. You can also place a face by hand if one is missed.

## 9. Making a photo book (Book)

The **Book** tab lays photos out on pages and makes a **PDF** you can print or send to a printer.

1. Press **New book** in the left panel (or the button in the middle). Give it a name.
2. **Choose a page size** under Book: square (8 or 12 inch), landscape, portrait, or A4 either way. You can switch on **page numbers**.
3. **Make pages from photos**: select photos in the Library first, then in the Book tab choose how many photos go on each page (1, 2, 3, 4 or 6) and press the button. Pages are added after any that are already there.
4. Or build pages by hand: **Add page**, then pick an **Arrangement** (blank, full page, one photo, photo and caption, two side by side, two stacked, three, four, six, text only).
5. **Fill the frames**: drag a photo from the filmstrip onto a frame, or click a frame and press **Use the selected photo**. A frame can hold a photo or text.
6. **Adjust a frame**: drag to move it, drag its corner to resize, or use the arrow keys (Shift for bigger steps); **Delete** removes it. For a photo you can choose **Fill frame** (crops to fit; two sliders choose which part of the photo stays) or **Show whole photo**. For text, choose the size, alignment, bold and colour; text that does not fit is made smaller. **Add text** puts a text frame on the page.
7. The page controls let you **add, copy, move earlier or later, and delete pages**, and change the page colour. A strip of all the pages is under the page.
8. **Undo and redo** work in the Book (Ctrl+Z and Ctrl+Y).
9. Press **Make PDF…**, choose a folder, and wait for the progress bar. The file is named after your book; a file that is already there is never replaced (a number is added).

The photos in the PDF are the photos **with your edits**, prepared at up to 300 dots per inch. If a photo cannot be found, its frame becomes a grey box and the result tells you which page.

Books are kept in the catalog and saved as you work, so they are not lost if you close the program; switching to another catalog shows that catalog's books.

**Limits.** Up to 200 pages and 12 frames to a page. Only the font Helvetica is used. There are no facing pages with a spine or cover, no bleed or crop marks, no printer colour (CMYK) and no rotated frames. Please open the first PDF you make and look at it carefully before printing anything.

## 10. Getting photos out (Export)

Select photos and press **Export…**. A preview on the right shows how the first photo will look.

- **Preset**: pick a starting point (Web, 2048 px JPEG; Social media, 1080 px with a border; Portfolio with camera settings; Client proofs, watermarked; Print, full size TIFF in Adobe RGB; Archive, full size PNG), or set things yourself. You can save your own presets.
- **To**: choose the destination folder. Tick **Put the files in a new folder** to make a folder just for this export (you name it).
- **File format**: JPEG (with a quality setting), PNG, TIFF or lossless WebP. Files are tagged with the colour profile you choose (sRGB, Adobe RGB, Display P3 or ProPhoto) so other programs show the colours correctly. Note that Lucent Raw edits in sRGB, so a wider profile labels the colours correctly but cannot add colours beyond sRGB.
- **Size**: the longest side in pixels (0 keeps the size). **Enlarge small photos** (none, smooth, or AI) is used only when the photo is smaller than the size asked.
- **Sharpening**: none, for screen, or for print.
- **Names**: a name pattern using {name}, {date}, {seq} and {camera}. A name already taken gets a number added; nothing is ever overwritten.
- **Watermark**: your text or a picture, with position, size, opacity and a shadow.
- **Border**: a coloured frame, optionally with a caption of the camera settings, the date and a note.
  - **Layout**: *Two lines* (camera and lens, then the settings), *One line* (everything together) or *One line for each item*. Your own note always stays on a line of its own above.
  - **Between items**: a dot, a bar, a slash, or space only; and how much room round it: close together, normal or wide.
  - **Letters**: light, regular, semibold or bold. These use the matching Segoe UI font that comes with Windows; on a computer without it the nearest available weight is used, and a missing weight never stops an export.
- **Keep camera details in the file** (JPEG only): puts the camera, lens, exposure, aperture, ISO, focal length and date taken into the exported file. **Where the photo was taken is never copied.**

Exporting is the only way your edits leave Lucent Raw as a picture. An exported picture is a normal file you can use anywhere.

## 11. Looking after your catalog

Click the catalog name in the Library's left panel (it says "Main catalog" at first) to open the **Catalogs** window.

### Several catalogs

You can keep more than one catalog, for example one per year or per client. The window lists them, with how many photos each holds. You can **switch** to another, **make a new one** (in the program's own folder or one you choose), **open an existing one** (a catalog folder from another drive or computer), **rename** one, or **take one off the list** (the catalog's folder and your photos are not touched). The catalog that is open cannot be taken off the list. Each catalog has its own ratings, keywords, edits and books.

### Backing up

Under **Look after this catalog**, **Back up…** asks for a folder and makes a new folder inside it, named after the catalog and the time, holding a copy of the catalog. The copy is made safely even while you work, and is checked as soon as it is written; a copy that fails its own check is deleted. **Nothing is ever replaced.** The window shows when you last backed up and, if it has been too long, reminds you (you choose how long in Preferences).

A backup holds your ratings, flags, labels, keywords, text, collections, edits and books. It does **not** copy your photos (they stay where they are) or the previews (they are made again).

**To use a backup**: in the Catalogs window press **Open an existing catalog…** and choose the backup's folder. Previews are made again when it opens.

**Automatic backups.** The Catalogs window has an **Automatic backups** section. With it on (it is on by default), a copy of the catalog is made in the background when Lucent Raw starts or you open a catalog, if the last one is older than the number of days you set (one day to start with). The copies are kept inside the catalog's own folder, in a folder called backups; the newest seven are kept and older ones are deleted (you can keep from 1 to 30). Each copy is checked after it is written. **Back up now** makes one at once. If a catalog is ever changed to a newer layout, a copy is made first and is never deleted by the program.

**Restoring.** Each copy in the list has **Restore…**. After you confirm, the catalog as it is now is saved as a "Before a restore" copy in the same list, then the chosen copy takes its place and the window starts again from it. A restore can therefore be undone by restoring the "Before a restore" copy. These copies do not protect against a failing disk, because they sit on the same disk as the catalog; use **Back up…** to put a copy on another drive.

**Check for problems** asks the database whether it is sound and whether everything it links to is where it should be. It changes nothing; if it finds a problem, make a backup first.

**Back up before something risky, and from time to time.** Copying the backup to another drive or a cloud folder is a good idea: a backup on the same disk does not protect you if the disk fails.

### Missing photos

If photos show **! missing**, press **Find missing photos…** in the same window. It looks for every file and lists, by folder, which photos are missing and whether the folder itself is gone (moved, renamed, or a drive not connected) or only some files. Then:

- **It moved…**: if a whole folder moved, say where it is now. The window first shows how many of its photos are there, and changes nothing until you press **Use this folder**.
- **Search a folder for them…**: it looks through a folder (and the folders inside) for files with the same name and size and reconnects what it finds. Doubtful matches (two identical files) are left alone, and it says how many.

Nothing is moved, copied or deleted. Your edits and ratings stay with the photo. Plugging a drive back in and pressing **Look again** is often all that is needed.

### Sidecar files (XMP)

A **sidecar** is a small text file kept next to a photo (`name.xmp` beside a RAW file, `name.jpg.xmp` beside anything else). It holds the stars, flag, label, title, caption, creator, copyright, keywords and edits, so they are not only inside the catalog. Other photo programs, such as darktable and digiKam, can read the stars, labels, text and keywords from it. The edits are in Lucent Raw's own form and only Lucent Raw uses them.

In **Sidecar files…**:

- **Write sidecar files by themselves** (off until you tick it): files are written a few seconds after you change something.
- **Write now**: for the photos changed since their sidecar was written, for all photos, or for the selected ones.
- **A sidecar from another program is never overwritten.** It is left alone and listed by name, because it may hold that program's edits.
- **Read**: **Look at the sidecars** says how many were found and how many differ from the catalog, and in what way, and changes nothing. **Update** then makes the catalog agree: stars, flags, labels and text are replaced by what the sidecar says; keywords and edits are only added, never taken away. An edit that is read is one step in the History, so you can undo it.
- Virtual copies do not have sidecar files.

## 12. Preferences and previews

**Licence.** Lucent Raw can be tried free for 30 days from the day you first start it. While you are on trial a button beside Preferences shows the days left. Buy a licence key once and paste it into Preferences > Licence; it is checked on your computer, needs no internet and never expires, and it works for every update of the version you bought. If the trial ends without a key, edits to photos are not saved, but opening your catalog, rating, keywording and exporting keep working, so your photos and work are never locked inside the program.

The **sliders** button at the top right opens Preferences.

- **Previews**: the small pictures kept so the grid and Develop are quick. It shows how much room they take (and how many photos have none). **Make missing previews** fills any gaps. **Make every preview again** redoes them all (useful if previews look wrong). **Clear all previews…** deletes them to free room. It is safe: a preview that is missing is made again when you look at its photo, so the grid may fill in slowly at first. Previews are copies; your photos are not touched.
- **Appearance**: dark, light, or match my computer.
- **Develop**: the fine-tune arrows on sliders, and the grid shown inside the crop frame.
- **Catalog**: how often to be reminded to back up (a week, a month, three months, or never).
- **About**: the version, where your catalog is kept, and the main parts the program is built from with their licences.

Your choices are remembered. There are not many preferences yet: there is no language or units setting, and no setting for how the program uses your graphics card.

## 13. Letting an AI assistant help (AI connection)

Lucent Raw can let an AI assistant that runs **on your own computer** (such as Claude Code) look through your catalog and do a few safe things for you. It is **off** until you switch it on, in the **plug** button at the top right.

When it is on, the assistant can: look at which catalog is open and how many photos it holds; search photos (by name, stars, flag, label, camera, lens, ISO, focal length, aperture, date, folder, collection); read a photo's edits; set stars, flags and colour labels (up to 500 photos at once); change the main tone adjustments of one photo (it is saved as one undoable step labelled "AI: ..."); ask B BOT for suggestions (nothing is applied); run the cull check (it changes nothing); and export copies of up to 200 photos into a folder that already exists.

It **cannot** delete anything, remove photos from the catalog, change or delete your original files, switch or change catalogs, or use masks, spots or faces. Only three of its abilities change anything (marks, tone adjustments and exports), and exports never overwrite.

How it is protected: it listens only on this computer (nobody on your network or the internet can reach it); every request needs a secret **token**; requests that come from web pages are refused; it stops when you switch it off or close the program. The window shows the token (hidden until you press Show) and the one-line command that tells Claude Code how to connect. **Make a new token** (after a confirmation) stops the old one working. Photo names and captions are handed over as plain data and the assistant is told never to treat them as instructions.

Turn it off when you are not using it. It has not yet been tried with Claude Code itself on a real installed copy.

## 14. Keyboard shortcuts

**Everywhere**

| Key | What it does |
| --- | --- |
| ? | Open or close Help |
| D | Open the selected photo in Develop |
| Ctrl+' | Make a virtual copy of the selected photos |
| G | Back to the grid |
| Left, Right | Previous and next photo |
| 0 to 5 | Give that many stars (the same key again clears) |
| P, X, U | Pick, reject, clear the flag |
| 6, 7, 8, 9 | Colour label red, yellow, green, blue |
| L | Dim everything round the photo, then switch it off, then bring it back |

The single letters (D, G, E, P, X, U, B, L, J, C, Z) can be changed in Preferences > Keyboard shortcuts; this guide shows the ones the program comes with.

**Library**

| Key | What it does |
| --- | --- |
| E | Show one photo large |
| Arrow keys, Home, End | Move through the grid |
| Ctrl+A | Select all photos shown |
| Ctrl+Shift+V | Paste the copied settings onto the selected photos |
| B | Add or remove from the Quick Collection |
| Shift+B | Add to the target collection |
| Delete | Remove from the catalog (files stay unless you tick the Recycle Bin box) |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo a rating, flag or colour label |
| Ctrl+[ , Ctrl+] | Turn the selected photos left, right |
| Z | In the single-photo view: open Develop at 100% |

**Develop and Retouch**

| Key | What it does |
| --- | --- |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z or Ctrl+Y | Redo |
| Z | Zoom to 100% and back |
| \\ (backslash) | Show the photo before your edits |
| J | Show blown highlights (red) and crushed shadows (blue) |
| C | Open the crop frame (Esc or Enter to leave) |
| Double-click a slider's name | Put it back to its start |

**Book**

| Key | What it does |
| --- | --- |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Arrow keys (on a frame) | Move the frame (Shift for bigger steps) |
| Delete (on a frame) | Delete the frame |

## 15. Problems and answers

**A photo says "! missing".** Its file is not where the catalog expects. See "Missing photos" in chapter 11. If a drive is not plugged in, plug it in and press Look again.

**The grid shows grey boxes.** The previews are still being made (watch for a few seconds), or they were cleared. Open Preferences and press Make missing previews. A photo with a file type the program cannot read has no preview ("No preview yet").

**A RAW photo has no preview or will not open.** Lucent Raw reads RAW files with a library that knows each camera model. A camera released after this version, or a RAW type not in the list in chapter 4 (for example Sigma X3F or Phase One), may not work. For a camera the library does not know but whose file has a picture stored inside it, you still get that picture as a preview; developing or exporting such a file says it cannot be done yet. JPEG copies of the same photos always work. RAW support has been tested on a small number of files, not every camera.

**Develop is slow.** The edits are worked out on your processor, not the graphics card. Very large photos take longer to zoom to 100%. Close other heavy programs; clearing and rebuilding previews does not make it faster.

**My ratings and keywords are gone.** Check you are in the right catalog (Catalogs window). If you removed photos from the catalog on purpose or by mistake, their details went with them; open a backup (chapter 11) to bring them back.

**I deleted a photo in Windows Explorer.** The catalog still lists it and shows it as missing. Remove it from the catalog (select it, press Delete) or restore the file.

**Is anything sent over the internet?** No. Lucent Raw has no accounts and does not connect to anything. The built-in models for finding faces, choosing subjects, removing distractions and enlarging are part of the program and run on your computer. (The AI connection, if you switch it on, only listens on your own computer.)

**Where is my catalog?** The Preferences window, under About, shows the folder.

## 16. New in the latest builds

**A menu bar** sits under the module tabs: File, Edit, Photo, View, Window and Help. The items change with the module (Library has Undo and Redo for ratings, flags and labels; Develop has Undo, Redo, Auto tone, Before, Show clipping and Crop). Arrow keys move around it and Esc closes it.

**Quick Develop** (Library, right-hand column, closed to start with) moves the main sliders for every selected photo at once: single arrows are small steps, double arrows big ones. It also has a preset list, Auto tone, Auto WB and Reset all. Each press is one step in each photo's History.

**Turning photos in the Library:** Ctrl+[ and Ctrl+] (or Photo > Rotate left and right) turn the selected photos. The masks, spots, red-eye circles, faces and the crop frame are turned with the picture. In Develop the Transform panel does the same.

**Undo in the Library:** Ctrl+Z takes back the last rating, flag or colour label, Ctrl+Shift+Z puts it back (the Edit menu names what it would take back).

**Lights:** press L to dim everything round the photo, again to switch it off, again to bring it back (Esc also brings it back).

**Importing:** a develop preset, a details preset and keywords can be put on every photo an import adds; "Also skip suspected duplicates" skips a photo with the same name, capture moment and camera as one already in the catalog; file names can use `{name}`, `{date}`, `{time}`, `{year}`, `{month}`, `{day}`, `{seq}` (or `{seq:5}` for five digits), `{camera}`, `{lens}` and `{iso}`, numbering can start at any number, and patterns can be kept. A memory card that is plugged in (a removable drive, or any drive with a DCIM folder) is offered by name; Preferences says whether the program tells you, opens the Import window on it, or does nothing when one is plugged in. The window remembers what the last import used.

**Removing and deleting:** the Remove window can also move the files and their sidecar files to the Recycle Bin (nothing is removed from the catalog if they cannot be moved). Photo > Delete rejected photos selects the rejected ones and opens it.

**Collections:** collection sets are folders of collections (and of other sets): use the set button in the Collections panel, and "Put in set" for a collection. Deleting a set never deletes what is in it. Smart collections can turn any rule round with **Not** and group rules (a group has its own all-or-any, three levels deep).

**Keywords:** a keyword can have synonyms (found by the keyword list's find box), can be left out of sidecar files, or be private.

**Details:** five more details (headline, position held, instructions, job identifier, usage terms) join the other ten; all fifteen are written to sidecar files and read back.

**Missing photos:** a file that was renamed is found again by what is inside it; "Find this file…" in the Details panel reconnects one photo by hand; each time the program starts it looks for photos whose files have gone (a switch in Preferences).

**Export:** the size can be a box (width and height), a percentage or megapixels; the resolution (ppi) is written into JPEG, PNG and TIFF files; "Original file" copies the photo's own file as it is; the finished export can show its folder.

**Develop:** the tone curve has Red, Green and Blue curves and a parametric curve; the Straighten tool levels the frame along a line you draw; Brush has presets and "Undo last stroke"; the clipping warning (J) can colour by channel and take other levels; moving the crop frame keeps masks and spots on the same part of the picture. Z in the Library's single-photo view opens Develop at 100%.

**Previews:** Preferences can keep them to at most a number of GB and discard the old ones; a discarded preview is made again when needed.

**Preferences also holds:** an external editor ("Open in external editor" in the Library), a limit on processor threads, the keyboard letters (single letters can be changed), the display's colour profile, file size units (GB or GiB), what this catalog holds, and a reset button that keeps your presets, saved filters and licence.

## 16b. New since test 3

**Library:** *Compare* (C) puts the open photo on the left (the Select) and the next one on the right (the Candidate); the arrows change the Candidate. *Survey* (N) shows the selected photos together. *Stacks:* Ctrl+G groups the selected photos under the first, S opens and closes the stack, Ctrl+Shift+G takes it apart; Photo > Auto-stack groups photos taken close together in time or that look alike. *Smart previews* (2560 pixels) are built from Preferences, from File > Build smart previews, or by a tick in the Import window; with them a photo can still be edited and exported when its file is offline. *Synchronize folder* (right-click a folder) finds new files and files that have gone.

**Catalogs:** File > Catalogs has *Share photos between catalogs*: export the selected photos as a catalog of their own, or add the photos of another catalog to this one (a backup is made first; nothing is doubled). Preferences > Watched folder imports photos as they arrive in a folder; with the tick for showing each new photo big, it also works as a simple tethered view when the camera's own program saves into that folder.

**Develop:** each panel has an *eye* that switches its settings off for viewing. *Profiles* (Basic panel > Browse profiles) are looks the photo starts from. The toolbar (or Y) shows the picture alone, side by side with the original, or split. *Soft proofing* (the panel at the bottom of the right-hand column, S to show) previews the picture for a printer's colour profile. *Masks* have + Near, + Far (a depth range) and + Object (click an object), a *Lens blur* slider, and the Presets panel has adaptive presets that find the sky, subject or background first. Retouch has *Find dust* and *Find eyes*. The crop guides include triangles.

**Photo menu:** *AI Denoise* makes a cleaner copy of the open photo; *Merge to HDR* and *Merge to panorama* join selected photos into a new picture. These make a new JPEG beside the first photo, add it to the catalog and leave the originals alone.

**Print:** the Print tab (File > Print, Ctrl+P) lays the selected photos on pages (paper, orientation, margins, photos across and down, copies) and sends them to a printer or to Microsoft Print to PDF.

**Export:** the file can carry copyright details or all details (JPEG and PNG), DNG is a format, and the finished export can open the pictures in your editing program. **Import:** "Copy as DNG". **Sidecars:** Lightroom's develop settings are read from its sidecars (the ones that mean the same here). **Numbers:** Preferences can write numbers the English, German or French way.

**The AI tools** (denoise, subject, object, depth, fill, enlarge, faces) use small models that are built into or shipped with the program and run on your own computer; nothing is sent anywhere. Their licences are in `MODEL-LICENCES.txt`. The AI switch in Preferences hides every one.
## 17. What is not there yet

Lucent Raw is not yet a complete replacement for a large professional photo catalogue program. In plain terms, these are the main things **not** built:

- Signing the installer (it needs a code-signing certificate that has to be bought, so Windows warns when you run it) and update offers (the program never updates itself).
- Map, Slideshow and Web modules: these were left out on purpose.
- Controlling a camera's shutter from the program (tethered shooting: a watched folder covers what the camera's own program saves), and Content Credentials.
- Panorama merging that bends the pictures (the one here only shifts and blends), and ghost removal in HDR.
- Another company's camera profiles and preset formats.
- A choice of languages (English only) and dragging panels into a new order (solo mode and open all or close all are there).
- Spreads, covers and printer colour in the Book.
- 1:1 previews.
- Closed-eye detection in Cull; AVIF, DNG or 16-bit export.
- Camera colour profiles, and a working colour space wider than sRGB.
- Tried on real photos (Canon EOS 600D, RAW): AI denoise, depth, subject, object, near, far and sky masks, face and eye finding, Copy as DNG, Compare, Survey, Book and Print. Find dust is stricter now but can still mark real detail on busy photos, so check every spot it adds. Not tried on real hardware: printers, a second screen, a tethered camera, merges to HDR or panorama. Please tell me what looks wrong.
- Automatic checking of the catalog (backups are automatic; the check for problems is still a button).
- Editing the full list of professional metadata fields, and location.

If you need something here, say so: the file `whats-built.md` shows what is planned and what has been left out on purpose.
