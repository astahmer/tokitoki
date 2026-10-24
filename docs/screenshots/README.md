# Screenshot sources

The Linux gallery contains three figures covering four native desktop hosts.
All interfaces are captured from the repository adapters running under the
headless Sway E2E harness. Data comes from synthetic fixtures, not personal
provider accounts. The figures frame and label the screenshots; they do not
redraw interface elements.

| README figure | Native captures |
| --- | --- |
| `linux-shells.png` | DMS `previews/tab-overview.png` and Quickshell `previews/tab-tokens.png` |
| `linux-noctalia.png` | Noctalia `noctalia-readme-bar.png` and `noctalia-readme-menu.png` |
| `linux-plasma.png` | Plasma `plasma-readme-bar.png` and `plasma-readme-menu.png` |

Capture the source images using the [E2E instructions](../../e2e/README.md):

```sh
E2E_SHELL=dms E2E_IMAGE=tokitoki-e2e:latest E2E_OUT_DIR=/tmp/readme-dms ./e2e/run.sh
E2E_SHELL=quickshell E2E_IMAGE=tokitoki-e2e:latest E2E_OUT_DIR=/tmp/readme-quickshell ./e2e/run.sh
E2E_OUT_DIR=/tmp/readme-native ./e2e/native/run.sh
```

The native scenario closes the first-run Noctalia wizard and verifies that
the quota panel is open before taking its menu screenshot. README crops use
the fixed 1600 × 1000 test output, including the pinned Plasma viewer's window
decoration offset. Full compositor screenshots remain in the E2E output.

Generate the presentation HTML:

```sh
bun e2e/readme-gallery.mjs shells /tmp/readme-dms/previews/tab-overview.png /tmp/readme-quickshell/previews/tab-tokens.png > /tmp/linux-shells.html
bun e2e/readme-gallery.mjs noctalia /tmp/readme-native/noctalia-readme-bar.png /tmp/readme-native/noctalia-readme-menu.png > /tmp/linux-noctalia.html
bun e2e/readme-gallery.mjs plasma /tmp/readme-native/plasma-readme-bar.png /tmp/readme-native/plasma-readme-menu.png > /tmp/linux-plasma.html
```

Render the complete HTML pages to PNG at a viewport width of 1160 pixels for
DMS/Quickshell and 620 pixels for Noctalia and Plasma. Wait for all images and
fonts to load, capture the full content height, and save the results under the
filenames above. The renderer must resolve the absolute local image paths
(or inline their bytes). The checked-in figures were rendered with T3's HTML
preview tool and visually checked before publication.

The existing dashboard and macOS menu-bar images are separate from this Linux
gallery.
