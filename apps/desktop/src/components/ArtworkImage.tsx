import { useEffect, useMemo, useRef, useState } from "react";
import type { Provider, UnifiedTrack } from "@amp/core";
import { resolveArtwork } from "@/lib/desktopBridge";
import { createArtworkFallbackDataUrl } from "@/lib/artwork";

interface ArtworkImageProps {
  track: Pick<UnifiedTrack, "provider" | "providerTrackId" | "title" | "creators" | "artworkUrl">;
  alt?: string;
  className?: string;
}

function isRemoteUrl(value?: string): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export function ArtworkImage({ track, alt = "", className }: ArtworkImageProps) {
  // Memoize the fallback SVG so it isn't regenerated (encodeURIComponent + string build) on every
  // render — important when hundreds of rows are on screen.
  const fallback = useMemo(
    () => createArtworkFallbackDataUrl(track.provider, { title: track.title, creators: track.creators }),
    [track.provider, track.title, track.creators]
  );
  const [source, setSource] = useState(
    isRemoteUrl(track.artworkUrl) ? fallback : (track.artworkUrl ?? fallback)
  );
  const imgRef = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);

  // Only resolve artwork once the image is near the viewport. Opening the Library used to fire a
  // resolve IPC for every one of ~500 rows at once, which is what made it lag.
  useEffect(() => {
    const element = imgRef.current;
    if (!element || visible) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "250px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let active = true;
    if (!isRemoteUrl(track.artworkUrl)) {
      setSource(track.artworkUrl ?? fallback);
      return () => {
        active = false;
      };
    }

    setSource(fallback);

    void resolveArtwork({
      // Key the cache by the artwork URL so a higher-res variant fetches fresh instead of serving
      // the old cached image for this track id.
      artworkUrl: track.artworkUrl,
      cacheKey: track.artworkUrl
    }).then((result) => {
      if (active) {
        setSource(result.dataUrl ?? fallback);
      }
    });

    return () => {
      active = false;
    };
  }, [visible, fallback, track.artworkUrl]);

  return (
    <img
      ref={imgRef}
      src={source}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setSource(fallback)}
    />
  );
}
