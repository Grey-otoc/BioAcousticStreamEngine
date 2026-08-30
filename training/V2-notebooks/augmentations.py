import numpy as np
from opensoundscape.audio import Audio

def audio_time_mask(
    audio, max_masks=6, max_width=0.04, noise_to_signal_dB=-3, noise_color="white" # previous settings were masks=5 width=.02
):
    # convert max_width from fraction of sample to seconds
    max_width_seconds = audio.duration * max_width

    n_masks = np.random.randint(0, max_masks + 1)
    mask_lens = np.random.uniform(0, max_width_seconds, n_masks)
    # randomly choose start positions by divvying up the non-masked space
    unmasked_time = audio.duration - mask_lens.sum()
    splits = [0] + list(np.sort(np.random.uniform(0, 1, n_masks) * unmasked_time))
    unmasked_segment_lens = np.array(splits[1:]) - np.array(splits[:-1])
    unmasked_segment_starts = [0]
    t = 0
    for i in range(n_masks):
        # skip forward by unmasked length + mask len
        t += unmasked_segment_lens[i] + mask_lens[i]
        unmasked_segment_starts.append(t)
    # doesn't include the last one, we'll just get the end of the sample instead
    unmasked_segment_ends = list(
        np.array(unmasked_segment_starts[:-1]) + np.array(unmasked_segment_lens)
    )

    # choose noise dBFS based on signal level and desired noise:signal ratio
    noise_dBFS = audio.dBFS + noise_to_signal_dB

    samples = []
    for i in range(n_masks):
        samples.extend(
            audio.trim(unmasked_segment_starts[i], unmasked_segment_ends[i]).samples
        )
        samples.extend(
            Audio.noise(
                duration=mask_lens[i],
                sample_rate=audio.sample_rate,
                color=noise_color,
                dBFS=noise_dBFS,
            ).samples
        )
    # add the last segment of original audio, making sure we end up with correct total number of samples
    samples.extend(audio.samples[len(samples) - len(audio.samples) :])

    return audio._spawn(samples=samples)
