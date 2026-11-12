// NVIDIA NIM (Cosmos3 Nano) video models. Requests are answered by the
// server-side adapter in lib/nvidia/cosmos.js, not by Muapi.
const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

const promptInput = (description) => ({
  type: "string",
  title: "Prompt",
  name: "prompt",
  description,
});

const aspectRatioInput = {
  enum: ASPECTS,
  title: "Aspect Ratio",
  name: "aspect_ratio",
  type: "string",
  description: "Aspect ratio of the output video.",
  default: "16:9",
};

const durationInput = {
  title: "Duration",
  name: "duration",
  type: "int",
  description: "Length of the generated video in seconds (720p is capped at about 8s).",
  default: 5,
  minValue: 2,
  maxValue: 12,
  step: 1,
};

const resolutionInput = {
  enum: ["480p", "720p"],
  title: "Resolution",
  name: "resolution",
  type: "string",
  description: "The resolution of the generated video.",
  default: "480p",
};

const base = {
  family: "nvidia",
  provider: "nvidia",
  provider_name: "NVIDIA",
};

export const nvidiaT2VModels = [
  {
    ...base,
    id: "nvidia-cosmos3-nano-t2v",
    name: "Cosmos3 Nano (NVIDIA)",
    endpoint: "nvidia-cosmos3-nano-t2v",
    hasPrompt: true,
    promptRequired: true,
    description: "NVIDIA Cosmos3 Nano text-to-video via NVIDIA NIM.",
    inputs: {
      prompt: promptInput("Describe the video to generate."),
      aspect_ratio: aspectRatioInput,
      duration: durationInput,
      resolution: resolutionInput,
    },
  },
];

export const nvidiaI2VModels = [
  {
    ...base,
    id: "nvidia-cosmos3-nano-i2v",
    name: "Cosmos3 Nano (NVIDIA)",
    endpoint: "nvidia-cosmos3-nano-i2v",
    imageField: "image_url",
    hasPrompt: true,
    description: "NVIDIA Cosmos3 Nano image-to-video via NVIDIA NIM.",
    inputs: {
      prompt: promptInput("Optional: describe the motion for the reference image."),
      aspect_ratio: aspectRatioInput,
      duration: durationInput,
      resolution: resolutionInput,
    },
  },
];

export const nvidiaV2VModels = [
  {
    ...base,
    id: "nvidia-cosmos3-nano-v2v",
    name: "Cosmos3 Nano (NVIDIA)",
    endpoint: "nvidia-cosmos3-nano-v2v",
    videoField: "video_url",
    hasPrompt: true,
    description:
      "NVIDIA Cosmos3 Nano video-to-video via NVIDIA NIM. Generates from a reference video; aspect ratio follows the clip.",
  },
];
