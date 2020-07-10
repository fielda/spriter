const ShelfPack = require('@mapbox/shelf-pack');
const sharp = require('sharp');
const genEtag = require('etag');
const fresh = require('fresh');
const pLimit = require('p-limit');
const fetch = require('node-fetch');
const fs = require("fs");

// Generated by sharp (./scripts/gen_empty_img.sh)
const EMPTY_PNG = fs.readFileSync(__dirname+"/empty_image.png");
  

function qsToggle (qs, k) {
  const valid = ["", "true", "1"]
  return valid.includes(qs[k]);
}

function json (imgs, {pixelRatio}) {
  const sprite = new ShelfPack(1, 1, { autoResize: true });
  const results = sprite.pack(imgs, { inPlace: true });

  const out = {};
  results.forEach(item => {
    out[item.id] = {
      "pixelRatio": pixelRatio,
      "width": item.w*pixelRatio,
      "height": item.h*pixelRatio,
      "x": item.x*pixelRatio,
      "y": item.y*pixelRatio,
    };
  })
  return {
    width: sprite.w*pixelRatio,
    height: sprite.h*pixelRatio,
    images: imgs,
    boxes: out,
    pixelRatio,
  };
}

async function png (spriteJson, opts={}) {
  const {pixelRatio, boxes, images, width, height} = spriteJson;

  function insertImageUrl (def) {
    const img = boxes[def.id];
    return {
      ...def,
      ...img,
    };
  }

  const imgs = await fetchImages(
    images.map(insertImageUrl),
    opts,
  );

  const hasMissingImages = !!imgs.find(img => img.missing);

  if (!imgs.length) {
    return EMPTY_PNG;
  }

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
  .composite(imgs.map(img => {
    return {
      left: img.x,
      top: img.y,
      input: img.buffer,
    };
  }))
  .png()
  .toBuffer()

  return {
    hasMissingImages,
    buffer,
  };
}

async function fetchImage (imgDef) {
  try {
    const resp = await fetch(imgDef.url);
    const {status} = resp;
    if (status < 200 || status >= 300) {
      console.warn("Not found: '%s'", imgDef.url);
      return {
        ...imgDef,
        missing: true,
        buffer: EMPTY_PNG,
      }
    }
    if (imgDef.buffer) {
      return imgDef;
    }
    else if (imgDef.url.match(/\.svg$/i)) {
      const inBuffer = await resp.buffer();

      const image = sharp(inBuffer);
      const metadata = await image.metadata();
      const {width, height} = metadata;
      let {density} = metadata;
      const ratio = (imgDef.width / width);
      if (ratio > 1) {
        density = density * ratio;
      }

      const buffer = await sharp(inBuffer, {density})
      .resize(imgDef.width, imgDef.height)
      .png()
      .toBuffer();

      return {
        ...imgDef,
        buffer,
      };
    }
    else {
      const inBuffer = await resp.buffer();

      const buffer = await sharp(inBuffer)
        .resize(imgDef.width, imgDef.height)
        .png()
        .toBuffer();

      return {
        ...imgDef,
        buffer,
      };
    }
  }
  catch (_err) {
    console.warn(_err);
    return {
      ...imgDef,
      missing: true,
      buffer: EMPTY_PNG,
    };
  }
}

async function fetchImages (imgs, opts={}) {
  opts = {
    ...opts,
    concurrency: 10
  };
  const limit = pLimit(opts.concurrency);

  const promises = imgs.map(img => {
    return limit(async() => {
      const out = await fetchImage(img)
      return out;
    });
  });

  const out = await Promise.all(promises);
  return out;
}

async function convert(imgs) {
  const outJson = json(imgs);
  const {buffer, hasMissingImages} = await png(outJson);
  return {
    json: outJson.boxes,
    hasMissingImages,
    buffer,
  };
}

function middleware (resolver, opts={}) {
    const {
      concurrency,
      missingImageRetryInterval,
    } = {
      concurrency: 10,
      missingImageRetryInterval: 60,
      ...opts
    };

    return async function (req, res, next) {
    try {
      const imgs = await resolver(req);
      if (!imgs) {
        res.status(404).end();
        return;
      }

      const urlMatches = req.baseUrl.match(/(?:@([0-9]+)x)?\.(png|json)$/);
      if (!urlMatches) {
        throw new Error("Expected URL to have suffix of format /(@[0.9]+x)?\.(png|json)/")
      }

      const debugging = qsToggle(req.query, "debug");
      const pixelRatio = parseInt(urlMatches[1], 10);
      const format = urlMatches[2];

      const spriteJson = json(imgs, {pixelRatio});
      const apiResp = JSON.stringify(spriteJson.boxes, null, debugging ? 2 : 0);

      const etag = genEtag(apiResp);
      res.setHeader("etag", etag);

      // Etag check because it's cheap here and we don't have to do any JSON processing.
      if (fresh(req.headers, {etag})) {
        // Just use the browser/cdn cache.
        res.status(304).end();
        return;
      }

      if (format === "json") {
        res.setHeader("content-type", "text/json");
        res.send(apiResp);
        return;
      }
      else if (format === "png") {
        const {buffer, hasMissingImages} = await png(spriteJson, opts);
        if (hasMissingImages) {
          const etag = genEtag(buffer);
          res.setHeader("etag", etag);
          res.setHeader("Cache-Control", `public, max-age=${missingImageRetryInterval}`)
        }
        res.setHeader("content-type", "image/png");
        res.send(buffer).end();
      }
      else {
        throw new Error("Unexpected error");
      }
    }
    catch(err) {
      next(err);
      return;
    }
  }
}

module.exports = {
  middleware,
  png,
  json,
};
