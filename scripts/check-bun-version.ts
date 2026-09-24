// Warn when this Bun is not the one .bun-version pins: the images and CI run that one, and another can behave
// differently. Another Bun only warns, so `bun run serve` still starts.

const pin = (await Bun.file('.bun-version').text()).trim();
if (Bun.version !== pin) {
    console.warn(
        `Eigen pins Bun ${pin}, this is ${Bun.version}. Install it: curl -fsSL https://bun.sh/install | bash -s bun-v${pin}`,
    );
}
