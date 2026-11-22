import { integer, text, url } from '@loomcli/validators';

// The checks on the settings `status` reads as well as the command that uses
// them: `serve`'s listen address and the Collector's Hub and state directory.
// One definition keeps `status` refusing these settings exactly when the
// Service would refuse them.
export const listenHostCheck = text({ minLength: 1 });
export const listenPortCheck = integer({ max: 65_535, min: 0 });
export const hubUrlCheck = url({ protocols: ['http', 'https'] });
export const stateDirCheck = text();
