/**
 * Build entry for the offline transcript stylesheet (#713).
 * The console never loads this script. assets:build emits the CSS;
 * renderTranscriptHtml inlines that file into the archive HTML.
 */
import "./transcript-export.css";
