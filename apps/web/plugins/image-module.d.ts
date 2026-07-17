declare module "*?img" {
  export const src: string;
  export const sources: { srcSet: string; type: string }[];
  export const thumbhash: string;
  export const width: number;
  export const height: number;

  const imageData: {
    src: string;
    sources: { srcSet: string; type: string }[];
    thumbhash: string;
    width: number;
    height: number;
  };

  export default imageData;
}
