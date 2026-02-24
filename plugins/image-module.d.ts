declare module "*?img" {
  export const src: string;
  export const srcSet: string;
  export const thumbhash: string;
  export const width: number;
  export const height: number;

  const imageData: {
    src: string;
    srcSet: string;
    thumbhash: string;
    width: number;
    height: number;
  };

  export default imageData;
}
