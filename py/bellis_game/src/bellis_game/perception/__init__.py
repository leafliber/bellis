"""Read-only game frame perception and game profile declarations."""

from .frame import (
    EncodedFrame,
    FrameDiff,
    FrameTransform,
    PixelRect,
    encode_frame,
    frame_diff,
    norm_rect_to_pixels,
    ring_frame_to_rgb,
)
from .profile import GameProfile, ProfileError, VlmProfileConfig, load_game_profile
from .vlm import (
    VlmClient,
    VlmConfig,
    VlmError,
    VlmJsonResult,
    VlmUsage,
    parse_strict_json_object,
    resolve_vlm_api_key,
)

__all__ = [
    "EncodedFrame",
    "FrameDiff",
    "FrameTransform",
    "GameProfile",
    "PixelRect",
    "ProfileError",
    "VlmClient",
    "VlmConfig",
    "VlmError",
    "VlmJsonResult",
    "VlmProfileConfig",
    "VlmUsage",
    "encode_frame",
    "frame_diff",
    "load_game_profile",
    "norm_rect_to_pixels",
    "parse_strict_json_object",
    "resolve_vlm_api_key",
    "ring_frame_to_rgb",
]
