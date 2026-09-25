/* Минимальная замена three.js для заставки: одна сфера с текстурой,
   свой шейдер растворения, вращение и наклон сцены. 654 КБ библиотеки
   ради этого не нужны — здесь используется тот же WebGL напрямую.
   Интерфейс намеренно повторяет three.js, чтобы код заставки не менялся. */
(function (global) {
  'use strict';

  // ——— Матрицы 4x4 (column-major, как в WebGL) ———
  const m4 = {
    identity: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
    perspective(fovDeg, aspect, near, far) {
      const f = 1 / Math.tan(fovDeg * Math.PI / 360);
      const nf = 1 / (near - far);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0
      ]);
    },
    invert(m) {
      const inv = new Float32Array(16);
      const a00=m[0],a01=m[1],a02=m[2],a03=m[3];
      const a10=m[4],a11=m[5],a12=m[6],a13=m[7];
      const a20=m[8],a21=m[9],a22=m[10],a23=m[11];
      const a30=m[12],a31=m[13],a32=m[14],a33=m[15];
      const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10;
      const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
      const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30;
      const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
      let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
      if (!det) return m4.identity();
      det = 1 / det;
      inv[0]=(a11*b11-a12*b10+a13*b09)*det;
      inv[1]=(a02*b10-a01*b11-a03*b09)*det;
      inv[2]=(a31*b05-a32*b04+a33*b03)*det;
      inv[3]=(a22*b04-a21*b05-a23*b03)*det;
      inv[4]=(a12*b08-a10*b11-a13*b07)*det;
      inv[5]=(a00*b11-a02*b08+a03*b07)*det;
      inv[6]=(a32*b02-a30*b05-a33*b01)*det;
      inv[7]=(a20*b05-a22*b02+a23*b01)*det;
      inv[8]=(a10*b10-a11*b08+a13*b06)*det;
      inv[9]=(a01*b08-a00*b10-a03*b06)*det;
      inv[10]=(a30*b04-a31*b02+a33*b00)*det;
      inv[11]=(a21*b02-a20*b04-a23*b00)*det;
      inv[12]=(a11*b07-a10*b09-a12*b06)*det;
      inv[13]=(a00*b09-a01*b07+a02*b06)*det;
      inv[14]=(a31*b01-a30*b03-a32*b00)*det;
      inv[15]=(a20*b03-a21*b01+a22*b00)*det;
      return inv;
    },
    multiply(a, b) {
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          out[c * 4 + r] =
            a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
            a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      return out;
    },
    // Порядок вращений — как у three.js по умолчанию: XYZ.
    compose(pos, rot, scale) {
      const cx = Math.cos(rot.x), sx = Math.sin(rot.x);
      const cy = Math.cos(rot.y), sy = Math.sin(rot.y);
      const cz = Math.cos(rot.z), sz = Math.sin(rot.z);
      const m = new Float32Array(16);
      m[0]  = (cy * cz) * scale;
      m[1]  = (sx * sy * cz + cx * sz) * scale;
      m[2]  = (-cx * sy * cz + sx * sz) * scale;
      m[3]  = 0;
      m[4]  = (-cy * sz) * scale;
      m[5]  = (-sx * sy * sz + cx * cz) * scale;
      m[6]  = (cx * sy * sz + sx * cz) * scale;
      m[7]  = 0;
      m[8]  = (sy) * scale;
      m[9]  = (-sx * cy) * scale;
      m[10] = (cx * cy) * scale;
      m[11] = 0;
      m[12] = pos.x; m[13] = pos.y; m[14] = pos.z; m[15] = 1;
      return m;
    }
  };

  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    setScalar(v) { this.x = this.y = this.z = v; return this; }
    lerpVectors(a, b, t) {
      this.x = a.x + (b.x - a.x) * t;
      this.y = a.y + (b.y - a.y) * t;
      this.z = a.z + (b.z - a.z) * t;
      return this;
    }
    // Проекция точки камерой: из мира в нормализованные координаты экрана.
    project(camera) {
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      this.x -= cx; this.y -= cy; this.z -= cz;
      return this.applyMatrix4(camera.projectionMatrix);
    }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiplyScalar(k) { this.x *= k; this.y *= k; this.z *= k; return this; }
    divideScalar(k) { return this.multiplyScalar(k ? 1 / k : 0); }
    length() { return Math.hypot(this.x, this.y, this.z); }
    normalize() { return this.divideScalar(this.length()); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    addScaledVector(v, k) { this.x += v.x * k; this.y += v.y * k; this.z += v.z * k; return this; }
    subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    lerp(v, t) { return this.lerpVectors(this, v, t); }
    // Обратная проекция: из нормализованных координат экрана — в мир.
    unproject(camera) {
      const inv = m4.invert(camera.projectionMatrix);
      this.applyMatrix4(inv);
      this.x += camera.position.x;
      this.y += camera.position.y;
      this.z += camera.position.z;
      return this;
    }
    applyMatrix4(m) {
      const { x, y, z } = this;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
      this.x = (m[0] * x + m[4] * y + m[8]  * z + m[12]) / w;
      this.y = (m[1] * x + m[5] * y + m[9]  * z + m[13]) / w;
      this.z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      return this;
    }
  }

  // Общий предок: положение, поворот, масштаб, дети.
  class Object3D {
    constructor() {
      this.position = new Vector3();
      this.rotation = new Vector3();
      this.scale = 1;
      this.children = [];
      this.parent = null;
      this.matrixWorld = m4.identity();
    }
    add(child) { child.parent = this; this.children.push(child); return this; }
    // Пересчёт матриц по цепочке родителей: сцена вызывает это вручную,
    // когда меняет положение прямо посреди кадра.
    updateMatrixWorld() {
      const chain = [];
      let node = this;
      while (node) { chain.unshift(node); node = node.parent; }
      let matrix = null;
      for (const item of chain) {
        const factor = typeof item.scale === 'number' ? item.scale : (item._s || 1);
        const local = m4.compose(item.position, item.rotation, factor);
        matrix = matrix ? m4.multiply(matrix, local) : local;
        item.matrixWorld = matrix;
      }
      for (const c of this.children) c.updateWorld(this.matrixWorld);
      return this;
    }
    // Точка из системы координат объекта — в мировую.
    localToWorld(vector) {
      this.updateMatrixWorld();
      return vector.applyMatrix4(this.matrixWorld);
    }
    updateWorld(parentMatrix) {
      const factor = typeof this.scale === 'number' ? this.scale : (this._s || 1);
      const local = m4.compose(this.position, this.rotation, factor);
      this.matrixWorld = parentMatrix ? m4.multiply(parentMatrix, local) : local;
      for (const c of this.children) c.updateWorld(this.matrixWorld);
    }
    // Совместимость с three.js: scale.setScalar(v).
    get scaleProxy() { return this.scale; }
  }

  class Group extends Object3D {
    constructor() {
      super();
      const self = this;
      self._s = 1;
      // three.js хранит scale вектором и его меняют через setScalar. Сам
      // множитель держим числом в _s: матрица считается из чисел, а объект
      // в этом поле превращал её в NaN — сфера не попадала в кадр.
      Object.defineProperty(this, 'scale', {
        value: {
          setScalar(v) { self._s = v; return this; },
          get x() { return self._s; },
          get y() { return self._s; },
          get z() { return self._s; }
        },
        writable: false
      });
    }
  }

  class Scene extends Object3D {}

  class PerspectiveCamera extends Object3D {
    constructor(fov, aspect, near, far) {
      super();
      this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
      this.projectionMatrix = m4.perspective(fov, aspect, near, far);
    }
    updateProjectionMatrix() {
      this.projectionMatrix = m4.perspective(this.fov, this.aspect, this.near, this.far);
    }
  }

  // Сфера: позиции и текстурные координаты, как у SphereGeometry.
  class SphereGeometry {
    constructor(radius = 1, widthSegments = 32, heightSegments = 16) {
      const positions = [];
      const uvs = [];
      const indices = [];
      for (let iy = 0; iy <= heightSegments; iy++) {
        const v = iy / heightSegments;
        const theta = v * Math.PI;
        for (let ix = 0; ix <= widthSegments; ix++) {
          const u = ix / widthSegments;
          const phi = u * Math.PI * 2;
          positions.push(
            -radius * Math.cos(phi) * Math.sin(theta),
             radius * Math.cos(theta),
             radius * Math.sin(phi) * Math.sin(theta)
          );
          uvs.push(u, 1 - v);
        }
      }
      const row = widthSegments + 1;
      for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
          const a = iy * row + ix, b = a + 1, c = a + row, d = c + 1;
          if (iy !== 0) indices.push(a, c, b);
          if (iy !== heightSegments - 1) indices.push(b, c, d);
        }
      }
      this.positions = new Float32Array(positions);
      this.uvs = new Float32Array(uvs);
      this.indices = new Uint16Array(indices);
      this.disposed = false;
    }
    dispose() { this.disposed = true; }
  }

  class CanvasTexture {
    constructor(canvas) {
      this.image = canvas;
      this.needsUpdate = true;
      this._gl = null; this._tex = null;
      this.minFilter = null; this.magFilter = null;
      this.wrapS = null; this.wrapT = null;
      this.anisotropy = 1;
    }
    dispose() {
      if (this._gl && this._tex) this._gl.deleteTexture(this._tex);
      this._tex = null;
    }
  }

  class ShaderMaterial {
    constructor(params = {}) {
      this.uniforms = params.uniforms || {};
      this.vertexShader = params.vertexShader || '';
      this.fragmentShader = params.fragmentShader || '';
      this.transparent = !!params.transparent;
      this.side = params.side;
      this.depthWrite = params.depthWrite !== false;
      this._program = null;
    }
    dispose() { this._program = null; }
  }

  class Mesh extends Object3D {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
      this._buffers = null;
    }
  }

  class WebGLRenderer {
    constructor(params = {}) {
      this.domElement = params.canvas;
      const opts = {
        antialias: params.antialias !== false,
        alpha: params.alpha !== false,
        premultipliedAlpha: false
      };
      const gl = this.domElement.getContext('webgl', opts) ||
                 this.domElement.getContext('experimental-webgl', opts);
      if (!gl) throw new Error('WebGL недоступен');
      this.gl = gl;
      this._pixelRatio = 1;
      this._clear = { color: 0x000000, alpha: 0 };
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    setPixelRatio(v) { this._pixelRatio = v || 1; }
    setSize(w, h) {
      this._w = w; this._h = h;
      this.domElement.width = Math.floor(w * this._pixelRatio);
      this.domElement.height = Math.floor(h * this._pixelRatio);
      this.domElement.style.width = w + 'px';
      this.domElement.style.height = h + 'px';
    }
    setClearColor(color, alpha) {
      this._clear.color = color;
      this._clear.alpha = alpha === undefined ? 1 : alpha;
    }
    _compile(material) {
      const gl = this.gl;
      if (material._program) return material._program;
      // Подставляем то, что three.js добавляет сам: атрибуты и матрицы.
      const vsSource =
        'attribute vec3 position;\nattribute vec2 uv;\n' +
        'uniform mat4 projectionMatrix;\nuniform mat4 modelViewMatrix;\n' +
        material.vertexShader;
      const fsSource = 'precision highp float;\n' + material.fragmentShader;
      const make = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error('Шейдер: ' + gl.getShaderInfoLog(sh));
        }
        return sh;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, make(gl.VERTEX_SHADER, vsSource));
      gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fsSource));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('Программа: ' + gl.getProgramInfoLog(prog));
      }
      material._program = prog;
      return prog;
    }
    _upload(mesh) {
      const gl = this.gl;
      if (mesh._buffers) return mesh._buffers;
      const g = mesh.geometry;
      const mk = (data, target, Type) => {
        const buf = gl.createBuffer();
        gl.bindBuffer(target, buf);
        gl.bufferData(target, data, gl.STATIC_DRAW);
        return buf;
      };
      mesh._buffers = {
        position: mk(g.positions, gl.ARRAY_BUFFER),
        uv: mk(g.uvs, gl.ARRAY_BUFFER),
        index: mk(g.indices, gl.ELEMENT_ARRAY_BUFFER),
        count: g.indices.length
      };
      return mesh._buffers;
    }
    _texture(tex) {
      const gl = this.gl;
      if (tex._tex && !tex.needsUpdate) return tex._tex;
      if (!tex._tex) { tex._tex = gl.createTexture(); tex._gl = gl; }
      gl.bindTexture(gl.TEXTURE_2D, tex._tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      tex.needsUpdate = false;
      return tex._tex;
    }
    render(scene, camera) {
      const gl = this.gl;
      gl.viewport(0, 0, this.domElement.width, this.domElement.height);
      const c = this._clear.color;
      gl.clearColor(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, this._clear.alpha);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      scene.updateWorld(null);
      // Камера смотрит из своей позиции вдоль -Z: достаточно сдвига.
      const view = m4.identity();
      view[12] = -camera.position.x;
      view[13] = -camera.position.y;
      view[14] = -camera.position.z;

      const draw = (obj) => {
        if (obj instanceof Mesh) {
          const mat = obj.material;
          const prog = this._compile(mat);
          gl.useProgram(prog);
          const bufs = this._upload(obj);

          const mv = m4.multiply(view, obj.matrixWorld);

          gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'projectionMatrix'), false, camera.projectionMatrix);
          gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'modelViewMatrix'), false, mv);

          for (const name in mat.uniforms) {
            const u = mat.uniforms[name];
            const loc = gl.getUniformLocation(prog, name);
            if (!loc) continue;
            if (u.value instanceof CanvasTexture) {
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, this._texture(u.value));
              gl.uniform1i(loc, 0);
            } else if (typeof u.value === 'number') {
              gl.uniform1f(loc, u.value);
            }
          }

          const pos = gl.getAttribLocation(prog, 'position');
          gl.bindBuffer(gl.ARRAY_BUFFER, bufs.position);
          gl.enableVertexAttribArray(pos);
          gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 0, 0);

          const uv = gl.getAttribLocation(prog, 'uv');
          if (uv >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufs.uv);
            gl.enableVertexAttribArray(uv);
            gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 0, 0);
          }

          gl.disable(gl.CULL_FACE);           // side: DoubleSide
          gl.depthMask(!!mat.depthWrite);
          gl.enable(gl.DEPTH_TEST);

          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs.index);
          gl.drawElements(gl.TRIANGLES, bufs.count, gl.UNSIGNED_SHORT, 0);
        }
        for (const child of obj.children) draw(child);
      };
      draw(scene);
    }
    dispose() {
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    forceContextLoss() { this.dispose(); }
  }

  global.THREE = {
    Vector3, Object3D, Group, Scene, PerspectiveCamera,
    SphereGeometry, CanvasTexture, ShaderMaterial, Mesh, WebGLRenderer,
    DoubleSide: 2, LinearFilter: 1006,
    RepeatWrapping: 1000, ClampToEdgeWrapping: 1001
  };
})(window);
