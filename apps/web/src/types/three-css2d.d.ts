declare module 'three/examples/jsm/renderers/CSS2DRenderer' {
  import type { Camera, Object3D, Scene } from 'three';

  export class CSS2DObject extends Object3D {
    constructor(element?: HTMLElement);
    element: HTMLElement;
    center: { x: number; y: number };
  }

  export class CSS2DRenderer {
    constructor();
    domElement: HTMLElement;
    render(scene: Scene, camera: Camera): void;
    setSize(width: number, height: number): void;
  }
}
