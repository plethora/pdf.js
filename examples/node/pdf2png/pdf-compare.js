const Canvas = require('../../../../node-canvas');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nomnom = require('nomnom');
const Promise = require('bluebird');
const { writePngFileSync, } = require('node-libpng');

const writeFile = Promise.promisify(fs.writeFile);

const opts = nomnom
.option('pdf', {
  required: true,
  help: 'PDF Drawing'
})
.option('highqa-data', {
  required: true,
  help: 'Input HighQA Data'
})
.option('save-clips', {
  flag: true,
  help: 'Save clips for each item rendered'
})
.option('draw-dims', {
  flag: true,
  help: 'Draws dim rectangles'
})
.option('output', {
  abbr: 'o',
  required: true,
  help: 'Output folder'
})
.parse()

function optMkDir(dir) {
  try {
    fs.accessSync(dir);
  } catch (err) {
    fs.mkdirSync(dir);
  }
}

function NodeCanvasFactory() {}
NodeCanvasFactory.prototype = {
  create: function NodeCanvasFactory_create(width, height) {
    assert(width > 0 && height > 0, 'Invalid canvas size');
    const canvas = Canvas.createCanvas(width, height);
    const context = canvas.getContext('2d');
    return {
      canvas: canvas,
      context: context,
    };
  },

  reset: function NodeCanvasFactory_reset(canvasAndContext, width, height) {
    assert(canvasAndContext.canvas, 'Canvas is not specified');
    assert(width > 0 && height > 0, 'Invalid canvas size');
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },

  destroy: function NodeCanvasFactory_destroy(canvasAndContext) {
    assert(canvasAndContext.canvas, 'Canvas is not specified');

    // Zeroing the width and height cause Firefox to release graphics
    // resources immediately, which can greatly reduce memory consumption.
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  },
};

const pdfjsLib = require('../../../build/generic/build/pdf');

function saveClip(page, canvasAndContext, id) {
  const canvas = canvasAndContext.canvas;
  const rect = canvas.getWrittenBounds(0xffffffff);
  if (!rect) {
    return;
  }
  rect[2] += 1;
  rect[3] += 1;
  page._external_data.rects[id] = rect;
  const buf = canvas.copyRect(rect);
  const options = {
    width: rect[2] - rect[0],
    height: rect[3] - rect[1],
  };
  try {
    // ABGR
    console.log(`writing ${id}`);
    writePngFileSync(path.join(opts.output, `clip-${id}.png`), buf, options);
  } catch (err) {
    console.log(err);
  }
  // ARGB
  canvas.clearRect(rect, 0xffffffff);
}

function savePage(pdfDocument, pageNum, targetWidth=null, zoomValue=1., dims=[]) {
  return pdfDocument.getPage(pageNum)
  .then((page) => {
    page._external_data = {id: 0, data: [], rects: {}};
    let scale = 1.
    if (targetWidth) {
      scale = targetWidth / page._pageInfo.view[2];
    }
    // Render the page on a Node canvas with 100% scale.
    const viewport = page.getViewport({scale});
    const canvasFactory = new NodeCanvasFactory();
    const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
    const renderContext = {
      canvasContext: canvasAndContext.context,
      viewport: viewport,
      canvasFactory: canvasFactory,
    };

    if (opts['save-clips']) {
      page._external_data.cb = (id) => saveClip(page, canvasAndContext, id);
    }

    const renderTask = page.render(renderContext);
    return renderTask.promise.then(() => {
      if (opts['save-clips']) {
        const { data, rects } = page._external_data;
        Object.keys(rects).forEach(k => {
          data[k].rect = rects[k];
        });
        fs.writeFileSync(path.join(opts.output, `output-${pageNum}.json`), JSON.stringify(data, null, 2));
      }
      if (opts['draw-dims']) {
        canvasAndContext.context.fillStyle = 'red';
        dims.forEach((d, i) => {
          canvasAndContext.context.globalAlpha = 0.2;
          const center = d.ShapeCenter.split(',').map(v => parseFloat(v.trim()) * zoomValue);
          const points = d.ShapePoints.split(',').map(v => parseFloat(v.trim()) * zoomValue);
          const x = center[0];
          const y = center[1];
          canvasAndContext.context.fillRect(x, y, points[0], points[1]);
        });
      }
      return {
        data: page._external_data.data,
        image: canvasAndContext.canvas.toBuffer()
      };
    });
  });
}

function extract(filepath, part) {
  const pathParts = path.parse(filepath);
  const outputFilepath = path.join(opts.output, `${pathParts.name}-outline.json`)
  const rawData = new Uint8Array(fs.readFileSync(filepath));
  const loadingTask = pdfjsLib.getDocument(rawData);
  return loadingTask.promise.then(pdfDocument => {
    console.log(`Loaded ${pdfDocument.numPages} pages`);
    return Promise.all([
      pdfDocument.getOutline()
        .then((res) => {
          fs.writeFileSync(outputFilepath, JSON.stringify(res, null, 2));
        }),
        ...Array(pdfDocument.numPages)
        .fill()
        .map((_, page) => {
          const zoomValue = part.drawings[0].Notes.ZoomValue;
          const targetWidth = part.drawings[0].Notes.ImageSize[0];
          return savePage(pdfDocument, page + 1, targetWidth, zoomValue, part.dims)
          .then(({data, image}) => {
            const itemFilename = path.join(opts.output, `${pathParts.name}-commands-${page}.json`);
            const pngFilename = path.join(opts.output, `${pathParts.name}-${page}.png`);
            fs.writeFileSync(itemFilename, JSON.stringify(data, null, 2));
            return writeFile(pngFilename, image);
          });
        })
    ]);
  })
  .catch(err => console.log(err));
}

function getHighQAData() {
  const PartName = path.basename(opts.pdf).split('-')[0];
  const data = JSON.parse(fs.readFileSync(opts['highqa-data']).toString());
  const part = data.find(d => d.PartName === PartName);
  if (!part) {
    throw new Error(`Unable to find part ${PartName}`);
  }
  console.log(part.drawings[0].Notes);
  return part;
}

optMkDir(opts.output);
extract(opts.pdf, getHighQAData());
