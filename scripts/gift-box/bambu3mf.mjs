// Bambu Studio project 3MF for the lid: one object made of three parts, each
// pre-assigned to an AMS slot, with the tulle pause already on the layer slider
// and the P2S 0.4 / 0.12 mm settings the pause height depends on.
//
// The layout copies what Bambu Studio itself writes (checked against a real
// P2S tulle project): the object is a <components> wrapper whose parts live in
// 3D/Objects/object_1.model (3MF production extension), per-part extruders in
// Metadata/model_settings.config, the pause in custom_gcode_per_layer.xml
// (Bambu's own tulle project uses type="1" / "M400 U1"; ours is a type 4 custom
// entry that parks the head first — see PAUSE_GCODE).

import { readFileSync } from 'node:fs'
import { zipStore, meshXml, escapeXml, CONTENT_TYPES, RELS } from './kernel.mjs'
import { DIMS } from './dims.mjs'

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"'
const APP = '<metadata name="Application">BambuStudio-02.09.01.70</metadata><metadata name="BambuStudio:3mfVersion">1</metadata>'
const IDENTITY = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1'
const round4 = (x) => Math.round(x * 1e4) / 1e4

/**
 * The tulle pause. Bambu's plain pause (type 1, M400 U1) leaves the hot nozzle
 * resting on the print — here, in the middle of the window on a flower — while
 * the user slides the tulle in. So it is a custom entry (type 4) that lifts
 * 10 mm and parks the head at the back centre first, clear of the lid's back
 * edge (y = 128 + 65.7). Safe to resume from: the slicer's moves after a layer's
 * custom G-code are absolute (lift, travel, drop to the layer height).
 */
export const PAUSE_GCODE = ['G91', 'G1 Z10 F900', 'G90', `G1 X${DIMS.bed / 2} Y250 F9000`, 'M400 U1']

/**
 * The layer whose top is the tulle plane z (1-based, as Bambu's slider counts),
 * and the top of the layer after it — Bambu runs a layer's custom G-code before
 * printing that layer, so the pause is stored on `nextTop`.
 */
export function pauseLayer(z, first = DIMS.layer.first, step = DIMS.layer.step) {
  const k = (z - first) / step
  if (Math.abs(k - Math.round(k)) > 1e-6 || k < 0) throw new Error(`tulle plane ${z} is not on a layer boundary (${first} + n × ${step})`)
  return { layer: Math.round(k) + 1, top: round4(z), nextTop: round4(z + step), nextLayer: Math.round(k) + 2 }
}

export function projectSettings() {
  return readFileSync(new URL('./bambu-project-settings.json', import.meta.url), 'utf8')
}

/** parts: [{ name, manifold, extruder }] in print pose, centred on the origin. pause: pauseLayer(...) or null. */
export function writeBambuLid({ parts, pause, name = 'gift-box-lid' }) {
  const OBJ = parts.length + 1
  const centre = DIMS.bed / 2
  const partObjs = parts.map((p, i) => `<object id="${i + 1}" type="model">${meshXml(p.manifold)}</object>`).join('')
  const objectsModel = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}><metadata name="BambuStudio:3mfVersion">1</metadata><resources>${partObjs}</resources><build/></model>`
  const comps = parts.map((_, i) => `<component p:path="/3D/Objects/object_1.model" objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('')
  const mainModel = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>${APP}<resources><object id="${OBJ}" type="model"><components>${comps}</components></object></resources><build><item objectid="${OBJ}" transform="1 0 0 0 1 0 0 0 1 ${centre} ${centre} 0" printable="1"/></build></model>`
  const modelRels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
  const partCfg = parts.map((p, i) => `
    <part id="${i + 1}" subtype="normal_part">
      <metadata key="name" value="${escapeXml(p.name)}"/>
      <metadata key="matrix" value="${IDENTITY}"/>
      <metadata key="extruder" value="${p.extruder}"/>
    </part>`).join('')
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${OBJ}">
    <metadata key="name" value="${escapeXml(name)}"/>
    <metadata key="extruder" value="1"/>${partCfg}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="${OBJ}"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
</config>`
  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: mainModel },
    { name: '3D/_rels/3dmodel.model.rels', data: modelRels },
    { name: '3D/Objects/object_1.model', data: objectsModel },
    { name: 'Metadata/model_settings.config', data: modelSettings },
    { name: 'Metadata/project_settings.config', data: projectSettings() },
  ]
  if (pause) {
    entries.push({
      name: 'Metadata/custom_gcode_per_layer.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id="1"/>\n<layer top_z="${pause.nextTop}" type="4" extruder="1" color="" extra="${PAUSE_GCODE.join('&#10;')}" gcode="${PAUSE_GCODE.join('&#10;')}"/>\n<mode value="MultiAsSingle"/>\n</plate>\n</custom_gcodes_per_layer>\n`,
    })
  }
  return zipStore(entries)
}
