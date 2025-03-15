import { ImageResponse } from "next/og";

export const runtime = "edge";

type IconSize = {
  size: {
    width: number;
    height: number;
  };
  id: string;
};

export const iconSizes: IconSize[] = [
  {
    size: { width: 48, height: 48 },
    id: "small",
  },
  {
    size: { width: 72, height: 72 },
    id: "medium",
  },
  {
    size: { width: 192, height: 192 },
    id: "large",
  },
  {
    size: { width: 512, height: 512 },
    id: "extra-large",
  },
];

export async function generateImageMetadata(): Promise<IconSize[]> {
  return iconSizes.map((iconSize) => ({
    contentType: "image/png",
    ...iconSize,
  }));
}

export default function Icon({ id }: { id: string }) {
  let fill = "#000000	";
  if (process.env.NODE_ENV === "development") {
    fill = "#DC143C";
  }
  if (process.env.VERCEL_ENV === "preview") {
    fill = "#FFBF00";
  }

  const matchedSize = iconSizes.find((iconSize) => iconSize.id === id)?.size
    ?.width;
  const fontSize = matchedSize ? matchedSize / 2 : 42;

  return new ImageResponse(
    (
      // ImageResponse JSX element
      <div
        style={{
          fontSize: fontSize,
          background: fill,
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          borderRadius: "12px",
        }}
      >
        🚃
      </div>
    ),
    {
      width:
        iconSizes.find((iconSize) => iconSize.id === id)?.size?.width || 512,
      height:
        iconSizes.find((iconSize) => iconSize.id === id)?.size?.height || 512,
    }
  );
}
