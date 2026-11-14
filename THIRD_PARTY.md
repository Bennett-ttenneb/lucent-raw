# Third-party material

## YuNet face detection model

- File: `app/src-tauri/resources/face_detection_yunet_2023mar.onnx` (232,589 bytes, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`)
- Source: OpenCV Zoo, `models/face_detection_yunet` (https://github.com/opencv/opencv_zoo), downloaded 2026-10-17.
- Licence: MIT, Copyright (c) 2020 Shiqi Yu. The upstream licence file from the model's folder in OpenCV Zoo was downloaded on 18 October 2026 and is kept as `licences/LICENSE-YuNet.txt`.
- Used by `app/src-tauri/src/faces.rs`. The model is compiled into the program and runs on the user's own machine; nothing is sent anywhere.

## Real-ESRGAN general x4v3 enlarging model

- File: `app/src-tauri/resources/realesr-general-x4v3.onnx` (4,866,396 bytes, SHA-256 `924ebad6532777303582d4ce7811849b88869231a3ae7093e0f21200249df8d5`)
- Source: Hugging Face repository `jonathanst29/tinier-upscale-models` (an ONNX export of the official `realesr-general-x4v3.pth` of xinntao/Real-ESRGAN), downloaded 2026-10-18 with the user's approval.
- Licence: BSD-3-Clause, Copyright (c) 2021 Xintao Wang (Real-ESRGAN). The upstream licence file was downloaded on 18 October 2026 and is kept as `licences/LICENSE-Real-ESRGAN.txt`.
- Used by `app/src-tauri/src/upscale.rs` for the "AI" way of enlarging. Compiled into the program; runs on the user's own machine.

## U2-Net (u2netp) subject model

- File: `app/src-tauri/resources/u2netp.onnx` (4,574,861 bytes, SHA-256 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`)
- Source: Hugging Face `edgetools/u2netp` (a copy of the rembg project's `u2netp.onnx`), downloaded 2026-10-18 with the user's approval.
- Licence: Apache-2.0 (U2-Net, Xuebin Qin et al.). The upstream licence file was downloaded on 18 October 2026 and is kept as `licences/LICENSE-U2-Net.txt`.
- Used by `app/src-tauri/src/subject.rs` for the Subject and Background masks. Compiled into the program; runs on the user's own machine.

## MI-GAN 512 filling model

- File: `app/src-tauri/resources/migan-512-generator.onnx` (28,098,112 bytes, SHA-256 `40b78086443a1104b6aa47b19f91fd8679857ae1583e3730d72d6298f1a232f6`)
- Source: Hugging Face `FreeHugsForRobots/ps-inpaint-migan` (the 512 x 512 generator cut from `andraniksargsyan/migan`'s pipeline), downloaded 2026-10-18 with the user's approval.
- Licence: MIT, Copyright (c) 2024 Picsart AI Research (PAIR) (MI-GAN, ICCV 2023, trained on Places2). The upstream licence file was downloaded on 18 October 2026 and is kept as `licences/LICENSE-MI-GAN.txt`.
- Used by `app/src-tauri/src/inpaint.rs` for the Fill mode of spot removal. Compiled into the program; runs on the user's own machine.

## Montserrat (brand font)

- Files: `app/public/fonts/montserrat-latin-{300,400,500,600,700}-normal.woff2` and the licence `OFL-Montserrat.txt` there. Source: the `@fontsource/montserrat` package 5.3.0 (npm), downloaded 2026-10-18 with the user's approval; only the Latin subset of five weights was kept.
- Licence: SIL Open Font License 1.1 (The Montserrat Project Authors, https://github.com/JulietaUla/Montserrat); the licence text is shipped next to the font files.
- Used by the whole interface (the brand font, see `design/tokens.json`).

## Code libraries added for features

- `tract-onnx` (runs the ONNX model, pure Rust).
- `moxcms` (colour profiles; already a dependency of the `image` library).

## roxmltree (XML reader, used to read sidecar files)

- Source: the `roxmltree` crate 0.20 from crates.io (https://github.com/RazrFalcon/roxmltree), added 2026-10-18 as a build dependency.
- Licence: MIT or Apache-2.0 (at your choice), as stated in the crate. The licence text ships with the crate's source and has not been copied into `licences/` yet; do that before the app is distributed. It has no dependencies of its own. It is used with document type definitions switched off, so a sidecar cannot ask the reader to expand entities.

## Libraries whose licences ask for more than a notice (read this before the app is shared or sold)

A full list of every Rust library in the build and its licence is in `licences/DEPENDENCIES.txt` (529 libraries, made from the build itself on 2026-10-18). Almost all are MIT, Apache-2.0, BSD or similar, which only ask that a notice is kept. These are different:

- **rawler 0.8.0: LGPL-2.1.** This is the library that reads RAW files (Canon, Nikon, Sony and the others). It is built into the program. The LGPL allows a program with other licences to use it, but asks that the person who has the program can replace the library with a changed version, and that they are told they have that right. For a Rust program that is built as one file, the usual ways are: give them the source of the program (or its object files) so they can build it again with another version of rawler, or release the program under a licence that allows that. Not decided yet. Before the app is shared outside this computer, choose one of: comply with the LGPL (including a licence notice and a way to get the source), release the app as open source, or replace RAW reading with something permissively licensed (no good one is known). Other users of rawler are the dnglab project's tools. This is a note for the owner to decide with proper advice, not legal advice.
- **MPL-2.0: option-ext, selectors, cssparser, cssparser-macros, dtoa-short** (they come with Tauri's web page tools). MPL-2.0 asks that, if you change those libraries' files, you share the changed files; using them unchanged only needs a notice and a pointer to their source. They are not changed here.
- **r-efi, anymap3**: offered under several licences at once (one of them LGPL-2.1-or-later or BlueOak); the MIT and Apache-2.0 choices are taken, so nothing extra applies.

The licence texts of the libraries themselves are in their source packages; `licences/` holds the texts for the four models and will need the texts for MIT, Apache-2.0, BSD-3-Clause, LGPL-2.1 and MPL-2.0 added before distribution.
