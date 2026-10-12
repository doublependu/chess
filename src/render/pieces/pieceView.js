import {
  Group, Mesh, BufferGeometry, CylinderGeometry, MeshBasicMaterial, PlaneGeometry, CanvasTexture, Color,
} from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPieceParts, PIECE_HEIGHT, PIECE_RADIUS, decorTilt } from './geometry.js';
import { createPieceMaterial, createDecorMaterial, createOutlineMaterial, patchWarp } from '../materials.js';
import { squareToVec } from '../coords.js';

const PICK_LAYER = 1;

/** Builds and caches render geometry per piece type. */
export class PieceFactory {
  constructor({ segments = 24, blobShadows = false, outlines = true }) {
    this.segments = segments;
    this.blobShadows = blobShadows;
    this.outlines = outlines;
    this.cache = new Map();
    this.decorMat = createDecorMaterial();
    this.outlineMat = createOutlineMaterial(0.016);
    this.pickMat = new MeshBasicMaterial({ visible: false });
    if (blobShadows) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      grd.addColorStop(0, 'rgba(20,10,30,0.55)'); grd.addColorStop(1, 'rgba(20,10,30,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      this.blobMat = patchWarp(new MeshBasicMaterial({ map: new CanvasTexture(c), transparent: true, depthWrite: false }), 'blob');
      this.blobGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    }
  }

  get(type) {
    if (this.cache.has(type)) return this.cache.get(type);
    const { solid, decor } = buildPieceParts(type, { segments: this.segments });
    const solidMerged = mergeGeometries(solid.map((g) => g.clone()), false);
    // Render geometry: creased normals keep rims crisp; decor goes into a second group.
    const body = toCreasedNormals(solidMerged.clone(), (40 * Math.PI) / 180);
    body.deleteAttribute('uv');
    let render = body;
    if (decor.length) {
      const d = toCreasedNormals(mergeGeometries(decor, false), Math.PI);
      if (d.attributes.uv) d.deleteAttribute('uv');
      if (decorTilt(type)) d.translate(0, -0.83, -0.168).rotateZ(decorTilt(type)).translate(0, 0.83, 0.168);
      render = mergeGeometries([body, d], true);
    } else {
      render = mergeGeometries([body], true);
    }
    // Outline uses welded smooth normals so the hull has no cracks.
    const outline = solidMerged;
    outline.deleteAttribute('uv');
    render.computeBoundingSphere();
    const entry = { render, outline, height: PIECE_HEIGHT[type], radius: PIECE_RADIUS[type] };
    this.cache.set(type, entry);
    return entry;
  }

  dispose() {
    for (const e of this.cache.values()) { e.render.dispose(); e.outline.dispose(); }
    this.cache.clear();
  }
}

/**
 * One chess piece in the scene. Transform hierarchy:
 *   root   - board position + facing (set by move clips)
 *   body   - squash/stretch, tilt, hop (set by clips)
 *   idleG  - idle breathing/bob (set by the idle animator)
 */
export class PieceView {
  constructor(factory, type, color, square, id) {
    this.id = id;
    this.color = color;
    this.root = new Group();
    this.body = new Group();
    this.idleG = new Group();
    this.root.add(this.body);
    this.body.add(this.idleG);
    this.phase = (id * 0.6180339) % 1 * Math.PI * 2;
    this.alive = true;
    this.square = square;
    this.inClip = 0; // >0 while a clip drives this piece
    this.type = type;
    this.build(factory);
    this.setType(type);
    this.placeAt(square);
  }

  build(factory) {
    this.factory = factory;
    this.idleG.clear();
    if (this.pick) this.pick.removeFromParent();
    if (this.blob) { this.blob.removeFromParent(); this.blob = null; }
    this.material?.dispose();
    this.material = createPieceMaterial(this.color);
    this.mesh = new Mesh(new BufferGeometry(), [this.material, factory.decorMat]);
    this.mesh.castShadow = true;
    this.idleG.add(this.mesh);
    this.outline = null;
    if (factory.outlines) {
      this.outline = new Mesh(new BufferGeometry(), factory.outlineMat);
      this.idleG.add(this.outline);
    }
    if (!this.pickGeo) this.pickGeo = new CylinderGeometry(0.4, 0.4, 1, 10).translate(0, 0.5, 0);
    this.pick = new Mesh(this.pickGeo, factory.pickMat);
    this.pick.layers.set(PICK_LAYER);
    this.pick.userData.view = this;
    this.root.add(this.pick);
    if (factory.blobShadows) {
      this.blob = new Mesh(factory.blobGeo, factory.blobMat);
      this.blob.position.y = 0.006;
      this.blob.renderOrder = 1;
      this.root.add(this.blob);
    }
  }

  /** Re-creates meshes for a new quality tier, keeping position and state. */
  rebuild(factory) {
    const visible = this.root.visible;
    this.build(factory);
    this.setType(this.type);
    this.root.visible = visible;
  }

  setType(type) {
    this.type = type;
    const g = this.factory.get(type);
    this.mesh.geometry = g.render;
    if (this.outline) this.outline.geometry = g.outline;
    this.pick.scale.set(1, g.height + 0.05, 1);
    if (this.blob) this.blob.scale.setScalar(g.radius * 2.6);
    this.height = g.height;
    this.facing = this.defaultFacing();
  }

  defaultFacing(square = this.square) {
    // Knights (head along +x) look toward the opponent, turned toward the board centre so the
    // player sees their profile rather than the back of the head.
    if (this.type === 2) {
      const toward = this.color === 0 ? Math.PI / 2 : -Math.PI / 2;
      const file = square ? square.charCodeAt(0) - 97 : 0;
      const turn = (file < 4 ? -1 : 1) * (this.color === 0 ? 1 : -1) * 1.0;
      return toward + turn;
    }
    return this.color === 0 ? 0 : Math.PI;
  }

  placeAt(square) {
    this.square = square;
    squareToVec(square, 0, this.root.position);
    this.root.rotation.set(0, this.facing, 0);
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.scale.set(1, 1, 1);
    this.root.visible = this.alive;
    this.setFlash(0);
  }

  setFlash(v, color) {
    if (v <= 0) { this.material.emissive.setRGB(0, 0, 0); return; }
    this.material.emissive.copy(color || WHITE).multiplyScalar(v);
  }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    this.material.dispose();
    this.pickGeo.dispose();
  }
}

const WHITE = new Color(1, 1, 1);
export { PICK_LAYER };
