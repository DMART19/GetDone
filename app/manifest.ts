import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "GetDone UFO v2",
    short_name: "GetDone",
    description: "Your AI + infrastructure execution engine",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    categories: ["business", "productivity"],
    background_color: "#07111d",
    theme_color: "#07111d",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }]
  };
}
