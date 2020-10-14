const Canvas = require('../../../../node-canvas');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nomnom = require('nomnom');
const Promise = require('bluebird');

const writeFile = Promise.promisify(fs.writeFile);

const opts = nomnom
.option('source', {
  abbr: 's',
  required: true,
  help: 'Source directory'
})
.option('output', {
  abbr: 'o',
  required: true,
  help: 'Output directory'
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

optMkDir(opts.output);

function savePage(pdfDocument, pageNum, cb) {
  return pdfDocument.getPage(pageNum)
  .then((page) => {
    page._external_data = {id: 0, data: []};
    // Scale to 72dpi
    const scale = 2 / page.userUnit;
    // Render the page on a Node canvas with 100% scale.
    const viewport = page.getViewport({scale});
    const canvasFactory = new NodeCanvasFactory();
    const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
    const renderContext = {
      canvasContext: canvasAndContext.context,
      viewport: viewport,
      canvasFactory: canvasFactory,
    };

    const renderTask = page.render(renderContext);
    return renderTask.promise.then(() => {
      return {
        data: page._external_data.data,
        image: canvasAndContext.canvas.toBuffer()
      };
    });
  });
}

function extract(filepath) {
  const pathParts = path.parse(filepath);
  const outputFilepath = path.join(opts.output, `${pathParts.name}-outline.json`)
  const rawData = new Uint8Array(fs.readFileSync(filepath));
  const loadingTask = pdfjsLib.getDocument(rawData);
  return loadingTask.promise.then(pdfDocument => {
    // console.log(`Loaded ${pdfDocument.numPages} pages`);
    return Promise.all([
      pdfDocument.getOutline()
        .then((res) => {
          fs.writeFileSync(outputFilepath, JSON.stringify(res, null, 2));
        }),
        ...Array(pdfDocument.numPages)
        .fill()
        .map((_, page) => {
          return savePage(pdfDocument, page + 1)
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


const files = fs.readdirSync(opts.source);
let pdfFiles = files.filter(f => path.extname(f).toLowerCase() === '.pdf');
pdfFiles.sort((a, b) => {
  const part_id_a = parseInt(a.split('-')[0].substring(1), 10);
  const part_id_b = parseInt(b.split('-')[0].substring(1), 10);
  return part_id_a < part_id_b ? -1 : 1;
});
pdfFiles = pdfFiles.slice(0, 500)


let count = 0;
Promise.map(
  pdfFiles,
  f => {
    ++count;
    console.log(`${count}/${pdfFiles.length}`)
    return extract(path.join(opts.source, f))
  },
  {
    concurrency: 10
  }
)
.catch(err => console.log(err));
