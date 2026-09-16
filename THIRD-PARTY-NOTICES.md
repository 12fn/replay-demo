# Third-party notices

REPLAY integrates the OpenFront core pinned in `vendor/openfront/UPSTREAM.json`. The combined code is distributed under GNU AGPL v3; see LICENSE and the upstream licensing document. Preserve corresponding source when providing the application over a network. The app will expose a source/package link in its deployment.

OpenFront map and other copied resources retain their upstream asset licenses in `vendor/openfront/LICENSE-ASSETS` and `vendor/openfront/LICENSING.md`. World terrain is a downsampled version of the upstream world fixture; the transformation is in `src/engine/maps.ts`. No proprietary OpenFront asset pack is included.

JavaScript dependencies retain their package-specific license files in the installed packages and lockfile. A release dependency inventory is generated with the handoff package.

Kamiwaza operator/core images are the user's existing licensed platform installation. They are not included in this repository or licensed by REPLAY.

## App-view capture

html-to-image 1.11.13 is used under the MIT license. Copyright (c) 2017-2025 W.Y. The package's full license is included in node_modules/html-to-image/LICENSE in the installed distribution. Source: https://github.com/bubkoo/html-to-image .

MIT License

Copyright (c) 2017-2025 W.Y.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Taiwan Strait terrain

Taiwan Strait manifest and map binaries are from the same pinned OpenFront commit `0f2ef7c43511cfb413a95e07d364139249d6905d`, `resources/maps/taiwanstrait`. The played terrain is upstream map16x.bin unchanged (400×400); REPLAY derives a 200×200 minimap. They retain the upstream asset license cited above. Exact source URLs and hashes: `evidence/platform/taiwan-map-source-20260915.json`.
